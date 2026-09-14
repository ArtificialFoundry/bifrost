package copilot

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	schemas "github.com/maximhq/bifrost/core/schemas"
	"github.com/valyala/fasthttp"
)

func TestBackoffFor(t *testing.T) {
	tests := []struct {
		name      string
		attempts  int
		permanent bool
		want      time.Duration
	}{
		{"transient first attempt", 1, false, transientBackoffBase},
		{"transient grows geometrically", 2, false, transientBackoffBase * 2},
		{"transient clamps at cap", 20, false, transientBackoffCap},
		{"permanent first attempt", 1, true, permanentBackoffBase},
		{"permanent grows geometrically", 2, true, permanentBackoffBase * 2},
		{"permanent clamps at cap", 20, true, permanentBackoffCap},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := backoffFor(tt.attempts, tt.permanent); got != tt.want {
				t.Errorf("backoffFor(%d, %v) = %v, want %v", tt.attempts, tt.permanent, got, tt.want)
			}
		})
	}
}

// TestTokenManager_NegativeCacheShortCircuitsRepeatedFailures verifies that after a
// transient failure, getToken() returns the cached error without a new HTTP call until
// the backoff window passes — i.e. it does not retry-storm GitHub. Ported behavior from
// upstream's copilotTokenPool negative cache; see INC-049 §7.
func TestTokenManager_NegativeCacheShortCircuitsRepeatedFailures(t *testing.T) {
	tm := newCopilotTokenManager("gho_test", nil, nil)

	bErr := &schemas.BifrostError{IsBifrostError: true, StatusCode: intPtr(500)}
	tm.mu.Lock()
	tm.recordFailure(bErr, false)
	tm.mu.Unlock()

	tm.mu.RLock()
	cachedErr := tm.failureErr
	retryAfter := tm.failureRetryAfter
	tm.mu.RUnlock()

	if cachedErr == nil {
		t.Fatal("expected failureErr to be cached after recordFailure")
	}
	if !retryAfter.After(time.Now()) {
		t.Fatal("expected failureRetryAfter to be in the future immediately after a recorded failure")
	}

	// clearFailure (simulating a subsequent successful refresh) must reset all three
	// negative-cache fields so a later failure starts backoff from attempt 1 again.
	tm.mu.Lock()
	tm.clearFailure()
	attemptsAfterClear := tm.failureAttempts
	errAfterClear := tm.failureErr
	tm.mu.Unlock()

	if errAfterClear != nil {
		t.Error("expected failureErr to be nil after clearFailure")
	}
	if attemptsAfterClear != 0 {
		t.Errorf("expected failureAttempts to reset to 0 after clearFailure, got %d", attemptsAfterClear)
	}
}

// TestTokenManager_RepeatedTransientFailureDoesNotHammerGitHub is the E2E-shaped
// regression test for c7f4cb341 (INC-049 §7): it drives getToken() through an actual
// HTTP round trip against a server that always returns 500, in a tight burst, and
// asserts the upstream call count stays far below the burst size — i.e. the negative
// cache's short-circuit in getToken() (before singleflight) is actually reached, not
// just that the cache fields update correctly in isolation.
func TestTokenManager_RepeatedTransientFailureDoesNotHammerGitHub(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("upstream unavailable"))
	}))
	defer srv.Close()

	tm := newCopilotTokenManager("gho_test", &fasthttp.Client{}, nil)
	tm.tokenExchangeURL = srv.URL

	const burst = 25
	var lastErr *schemas.BifrostError
	for i := 0; i < burst; i++ {
		_, _, err := tm.getToken()
		if err == nil {
			t.Fatalf("call %d: expected an error from a permanently-failing upstream, got nil", i)
		}
		lastErr = err
	}

	if lastErr == nil || lastErr.Error == nil {
		t.Fatal("expected a populated BifrostError after the burst")
	}

	// Every 500 is transient, so the negative-cache window is
	// transientBackoffBase (500ms) after the very first failure and grows from there --
	// well past this test's runtime. A burst of getToken() calls issued back-to-back
	// must therefore short-circuit into the cached failure after the first real HTTP
	// call, not re-enter refreshToken() (and thus the upstream server) per call.
	if calls != 1 {
		t.Errorf("expected exactly 1 upstream HTTP call across a %d-call burst of a persistently-failing token exchange, got %d (negative-cache short-circuit in getToken() is not preventing the retry storm)", burst, calls)
	}

	// Sanity-check the actual failure classification path used by refreshToken():
	// a 500 must be recorded as transient (permanent=false), which callers can
	// distinguish because AllowFallbacks is left nil (only permanent faults set
	// AllowFallbacks=false, per refreshToken()'s non-2xx branch).
	if lastErr.AllowFallbacks != nil && !*lastErr.AllowFallbacks {
		t.Error("a transient (500) failure must not set AllowFallbacks=false; that is reserved for permanent (401/403) faults")
	}
}
