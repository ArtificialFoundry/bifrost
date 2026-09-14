// Package copilot implements the GitHub Copilot provider and its utility functions.
package copilot

import (
	"sync"
	"time"

	schemas "github.com/maximhq/bifrost/core/schemas"
	"github.com/valyala/fasthttp"
	"golang.org/x/sync/singleflight"
)

// CopilotEndpoints contains the API endpoints returned by the Copilot token exchange.
type CopilotEndpoints struct {
	API string `json:"api"`
}

// CopilotTokenResponse represents the response from the Copilot token exchange endpoint.
type CopilotTokenResponse struct {
	Token     string           `json:"token"`
	ExpiresAt int64            `json:"expires_at"`
	Endpoints CopilotEndpoints `json:"endpoints"`
}

// tokenResult bundles the values returned from a token refresh so they can be
// transported through singleflight.Group.Do (which returns a single interface{}).
type tokenResult struct {
	token   string
	apiBase string
	err     *schemas.BifrostError
}

// copilotTokenManager handles the two-layer auth flow for a single key.
// It caches the short-lived Copilot JWT and the dynamic API base URL,
// refreshing them automatically when they expire.
//
// Concurrent callers are coalesced via singleflight: only one goroutine
// performs the HTTP token exchange while others wait for the same result.
type copilotTokenManager struct {
	mu               sync.RWMutex
	apiToken         string    // Short-lived Copilot JWT
	apiBase          string    // Dynamic API base from token response
	expiresAt        time.Time // JWT expiry
	accessToken      string    // Long-lived GitHub OAuth access token (Key.Value)
	client           *fasthttp.Client
	logger           schemas.Logger
	tokenExchangeURL string // URL for token exchange; overridable in tests

	sfGroup singleflight.Group // coalesces concurrent refresh attempts

	// Negative cache: without this, a persistently-failing refresh (e.g. a revoked
	// OAuth token that GitHub answers with a 5xx, or a network blip) re-enters
	// refreshToken() on every single request past expiry with no floor on retry rate
	// — an unbounded retry storm against GitHub. Ported from upstream's
	// core/providers/githubcopilot/token.go exchangeFailure/copilotTokenPool pattern
	// (permanentBackoffBase/Cap, transientBackoffBase/Cap). This closes a real
	// standing prod risk independent of the provider-unification merge. See INC-049
	// §7 (Lessons Learned).
	failureErr        *schemas.BifrostError // cached error from the last failed refresh; nil when no failure is cached
	failureRetryAfter time.Time             // refreshToken() short-circuits to failureErr until this time passes
	failureAttempts   int                   // consecutive failures, for backoff growth
}
