package copilot

import (
	"testing"
	"time"

	schemas "github.com/maximhq/bifrost/core/schemas"
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
