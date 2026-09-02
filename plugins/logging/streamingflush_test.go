package logging

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/logstore"
)

// TestInjectFlushesStreamingCompletionWhenParkRaces verifies INC-039 at the
// logging layer: a SUCCESSFUL streaming completion must still be persisted even
// when the deferred Inject flush (producer goroutine) races ahead of the final
// chunk's storeOrEnqueueEntry park (provider goroutine).
//
// Real-world handoff that this mirrors:
//
//	provider goroutine  : final chunk -> PostLLMHook -> storeOrEnqueueEntry
//	                      (parks row in pendingLogsToInject[traceID])
//	producer goroutine  : drain stream -> defer traceCompleter
//	                      -> CompleteAndFlushTrace -> Inject
//
// storeOrEnqueueEntry runs BEFORE the final chunk is sent to the stream channel,
// so on a clean drain Inject cannot normally miss the park. But under load /
// restart the producer's deferred flush can still beat the park, in which case
// Inject's LoadAndDelete misses and — without a retry — the row is dropped. This
// test reproduces exactly that ordering deterministically: Inject is fired first
// (flush runs), then the provider's park lands a short time later. Unpatched
// Inject returns immediately on the miss and the row is lost; patched Inject
// waits within streamingFlushGrace and flushes the late park.
func TestInjectFlushesStreamingCompletionWhenParkRaces(t *testing.T) {
	store, err := logstore.NewLogStore(context.Background(), &logstore.Config{
		Enabled: true,
		Type:    logstore.LogStoreTypeSQLite,
		Config: &logstore.SQLiteConfig{
			Path: filepath.Join(t.TempDir(), "streaming-race.logging.db"),
		},
	}, testLogger{})
	if err != nil {
		t.Fatalf("NewLogStore() error = %v", err)
	}

	loggingHeaders := []string{"x-custom-log"}
	plugin, err := Init(context.Background(), &Config{LoggingHeaders: &loggingHeaders}, testLogger{}, store, nil, nil)
	if err != nil {
		t.Fatalf("Init() error = %v", err)
	}
	defer func() { _ = plugin.Cleanup() }()

	traceID := "trace-stream-flush-race"
	reqID := "req-stream-flush-race"

	// The provider goroutine parks the streaming success entry a short time AFTER
	// the flush fires. In real life this is the provider's final-chunk
	// storeOrEnqueueEntry racing the producer's deferred Inject. storeOrEnqueueEntry
	// is the exact code path the streaming PostLLMHook uses to park the row.
	var parkWG sync.WaitGroup
	parkWG.Add(1)
	go func() {
		defer parkWG.Done()
		time.Sleep(60 * time.Millisecond) // provider is slower / descheduled vs the flush

		entry := &logstore.Log{
			ID:        reqID,
			Provider:  "openai",
			Status:    logStatusSuccess,
			Object:    "chat_completion_stream",
			Stream:    true,
			Model:     "gpt-4o-mini",
			Timestamp: time.Now().UTC(),
			CreatedAt: time.Now().UTC(),
		}
		ctx := schemas.NewBifrostContext(context.Background(), schemas.NoDeadline)
		ctx.SetValue(schemas.BifrostContextKeyTraceID, traceID)
		plugin.storeOrEnqueueEntry(ctx, entry, nil)
	}()

	// Producer-side flush fires Inject "too early" — before the park lands. This
	// is the exact deferred handoff in the HTTP streaming producer goroutine.
	trace := &schemas.Trace{
		RequestID:  reqID,
		InternalID: traceID,
		TraceID:    traceID,
	}
	if err := plugin.Inject(context.Background(), trace); err != nil {
		t.Fatalf("Inject() error = %v", err)
	}

	// Wait for the park, then give the patched Inject's grace window + the async
	// batch writer time to land the row. On unpatched code Inject already returned
	// and the park is orphaned, so the row will never be written.
	parkWG.Wait()
	if err := plugin.Cleanup(); err != nil {
		t.Fatalf("Cleanup() error = %v", err)
	}

	// The acceptance gate: a successful chat_completion_stream row MUST exist.
	logEntry, err := store.FindByID(context.Background(), reqID)
	if err != nil {
		t.Fatalf("successful streaming completion was NOT persisted: FindByID(%q) error = %v (deferred Inject lost the parked log row to the flush/park race)", reqID, err)
	}
	if logEntry.ID != reqID {
		t.Fatalf("FindByID returned wrong row: id=%q want=%q", logEntry.ID, reqID)
	}
	if got := logEntry.Object; got != "chat_completion_stream" {
		t.Fatalf("Object = %q, want chat_completion_stream", got)
	}
	if got := logEntry.Status; got != logStatusSuccess {
		t.Fatalf("Status = %q, want %q", got, logStatusSuccess)
	}
	if !logEntry.Stream {
		t.Fatal("expected Stream=true on a streaming completion log row")
	}
	if traceVal, ok := plugin.pendingLogsToInject.Load(traceID); ok {
		t.Fatalf("pendingLogsToInject[%q] not cleared after flush: %+v", traceID, traceVal)
	}
}

// TestInjectPersistsSuccessfulStreamingCompletion is a positive-control that runs
// the REAL streaming final-chunk PostLLMHook path (not just storeOrEnqueueEntry):
// a successful chat_completion_stream final chunk parks a log row for the trace,
// and Inject then flushes it to the DB. This proves the deferred handoff persists
// when the park lands before Inject, independent of the race covered by
// TestInjectFlushesStreamingCompletionWhenParkRaces.
func TestInjectPersistsSuccessfulStreamingCompletion(t *testing.T) {
	store := newTestStore(t)
	plugin, err := Init(context.Background(), &Config{}, testLogger{}, store, nil, nil)
	if err != nil {
		t.Fatalf("Init() error = %v", err)
	}
	defer func() { _ = plugin.Cleanup() }()

	ctx := schemas.NewBifrostContext(context.Background(), schemas.NoDeadline)
	const reqID = "req-stream-success-persist"
	const traceID = "trace-stream-success-persist"
	ctx.SetValue(schemas.BifrostContextKeyRequestID, reqID)
	// A real streaming request carries BifrostContextKeyTraceID (set by the
	// tracing middleware in middlewares.go:1223). With it set, storeOrEnqueueEntry
	// parks the row for later Inject flush instead of enqueueing directly.
	ctx.SetValue(schemas.BifrostContextKeyTraceID, traceID)

	req := &schemas.BifrostRequest{
		RequestType: schemas.ChatCompletionStreamRequest,
		ChatRequest: &schemas.BifrostChatRequest{
			Provider: schemas.OpenAI,
			Model:    "gpt-4o-mini",
			Params:   &schemas.ChatParameters{},
		},
	}
	if _, _, err = plugin.PreLLMHook(ctx, req); err != nil {
		t.Fatalf("PreLLMHook() error = %v", err)
	}

	// Successful final streaming chunk (mirrors openai.go:746-759: the synthesized
	// final text-completion chunk wrapped into a BifrostResponse, with the
	// StreamEndIndicator flag already set).
	created := 12345
	finishReason := "stop"
	usage := &schemas.BifrostLLMUsage{}
	ctx.SetValue(schemas.BifrostContextKeyStreamEndIndicator, true)
	textResp := &schemas.BifrostTextCompletionResponse{
		ID:      "chunk-final",
		Model:   "gpt-4o-mini",
		Created: created,
		Object:  "text_completion",
		Usage:   usage,
		Choices: []schemas.BifrostResponseChoice{
			{
				FinishReason:                 &finishReason,
				TextCompletionResponseChoice: &schemas.TextCompletionResponseChoice{},
			},
		},
		ExtraFields: schemas.BifrostResponseExtraFields{
			ChunkIndex: 1,
		},
	}
	result := &schemas.BifrostResponse{TextCompletionResponse: textResp}
	result.PopulateExtraFields(schemas.ChatCompletionStreamRequest, schemas.OpenAI, "gpt-4o-mini", "gpt-4o-mini")
	result.PopulateRoutingInfo(schemas.RoutingInfo{})

	if _, _, err = plugin.PostLLMHook(ctx, result, nil); err != nil {
		t.Fatalf("PostLLMHook() error = %v", err)
	}

	// The row must have been PARKED (not written directly) — deferred flush.
	if _, ok := plugin.pendingLogsToInject.Load(traceID); !ok {
		t.Fatalf("expected successful streaming completion to be parked in pendingLogsToInject[%q]", traceID)
	}

	// Producer-side deferred flush (traceCompleter -> CompleteAndFlushTrace -> Inject).
	trace := &schemas.Trace{
		RequestID:  reqID,
		InternalID: traceID,
		TraceID:    traceID,
	}
	if err := plugin.Inject(context.Background(), trace); err != nil {
		t.Fatalf("Inject() error = %v", err)
	}
	if err := plugin.Cleanup(); err != nil {
		t.Fatalf("Cleanup() error = %v", err)
	}

	logEntry, err := store.FindByID(context.Background(), reqID)
	if err != nil {
		t.Fatalf("successful streaming completion was not persisted: FindByID(%q) error = %v", reqID, err)
	}
	if logEntry.Object != "chat_completion_stream" {
		t.Fatalf("Object = %q, want chat_completion_stream", logEntry.Object)
	}
	if logEntry.Status != logStatusSuccess {
		t.Fatalf("Status = %q, want %q", logEntry.Status, logStatusSuccess)
	}
	if !logEntry.Stream {
		t.Fatal("expected Stream=true on streaming completion log row")
	}
}
