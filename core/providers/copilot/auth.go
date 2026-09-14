package copilot

import (
	"fmt"
	"strings"
	"time"

	"github.com/bytedance/sonic"
	schemas "github.com/maximhq/bifrost/core/schemas"
	"github.com/valyala/fasthttp"
)

// newCopilotTokenManager creates a token manager for a given OAuth access token.
func newCopilotTokenManager(accessToken string, client *fasthttp.Client, logger schemas.Logger) *copilotTokenManager {
	return &copilotTokenManager{
		accessToken:      accessToken,
		client:           client,
		logger:           logger,
		apiBase:          defaultAPIBaseURL,
		tokenExchangeURL: defaultTokenExchangeURL,
	}
}

// resolveOAuthAccessToken returns the GitHub OAuth device-flow access token for a key.
//
// GithubCopilotOAuthKeyConfig.AccessToken is the typed, unambiguous source (see
// core/schemas/account.go and INC-049). Key.Value is read only as a legacy fallback for
// keys persisted before the typed split landed — e.g. prod's live config_providers id=5
// ("agent47nh") row, which stores its gho_-prefixed OAuth token in Value and has not yet
// been migrated (that migration is WBS 3.0, not this function's job). Once the typed
// config is present, it always wins over Value, so a key can never be resolved two ways.
func resolveOAuthAccessToken(key schemas.Key) string {
	if key.GithubCopilotOAuthKeyConfig != nil {
		if tok := strings.TrimSpace(key.GithubCopilotOAuthKeyConfig.AccessToken.GetValue()); tok != "" {
			return tok
		}
	}
	return key.Value.GetValue()
}

func intPtr(i int) *int { return &i }

// getToken returns a valid Copilot JWT and the API base URL.
// It refreshes the token if expired or about to expire.
// Concurrent callers share a single in-flight refresh via singleflight.
func (tm *copilotTokenManager) getToken() (token string, apiBase string, bifrostErr *schemas.BifrostError) {
	// Fast path: read-lock check for a cached, non-expired token.
	tm.mu.RLock()
	if tm.apiToken != "" && time.Now().Before(tm.expiresAt.Add(-time.Duration(tokenExpiryMargin)*time.Second)) {
		t, b := tm.apiToken, tm.apiBase
		tm.mu.RUnlock()
		return t, b, nil
	}
	tm.mu.RUnlock()

	// Slow path: coalesce concurrent refreshes through singleflight.
	val, _, _ := tm.sfGroup.Do("refresh", func() (interface{}, error) {
		return tm.refreshToken(), nil
	})
	res := val.(*tokenResult)
	return res.token, res.apiBase, res.err
}

// refreshToken exchanges the OAuth access token for a short-lived Copilot JWT.
// Called inside singleflight — at most one goroutine runs this at a time per key.
func (tm *copilotTokenManager) refreshToken() *tokenResult {
	req := fasthttp.AcquireRequest()
	defer fasthttp.ReleaseRequest(req)
	resp := fasthttp.AcquireResponse()
	defer fasthttp.ReleaseResponse(resp)

	req.SetRequestURI(tm.tokenExchangeURL)
	req.Header.SetMethod(fasthttp.MethodGet)
	req.Header.Set("authorization", "Bearer "+tm.accessToken)
	req.Header.Set("accept", "application/json")
	for k, v := range copilotRequiredHeaders {
		req.Header.Set(k, v)
	}

	// GitHub's token-exchange endpoint can issue a redirect for some accounts
	// (e.g. org/enterprise-scoped tokens redirected to a tenant-specific host).
	// fasthttp.Client.Do does NOT follow redirects (unlike net/http's default
	// client) -- a bare Do() would otherwise hang on the connection waiting for
	// a body that never satisfies the caller's expectations, or return a 3xx
	// response that our status-code handling below doesn't understand, until
	// the outer context deadline (15s) fires. DoRedirects follows up to a
	// bounded number of redirects while preserving req/resp for header
	// inspection.
	start := time.Now()
	err := tm.client.DoRedirects(req, resp, 3)
	elapsed := time.Since(start)
	if tm.logger != nil {
		location := string(resp.Header.Peek("Location"))
		tm.logger.Debug("copilot: token exchange transport attempt",
			"status", resp.StatusCode(),
			"body_bytes", len(resp.Body()),
			"had_location_header", location != "",
			"elapsed_ms", elapsed.Milliseconds(),
			"transport_err", err != nil,
		)
	}
	if err != nil {
		tm.mu.RLock()
		cached := tm.apiToken != "" && time.Now().Before(tm.expiresAt)
		t, b := tm.apiToken, tm.apiBase
		tm.mu.RUnlock()
		if cached {
			if tm.logger != nil {
				tm.logger.Warn("copilot: token exchange transport failed; using cached token",
					"error", err.Error())
			}
			return &tokenResult{token: t, apiBase: b}
		}
		return &tokenResult{err: &schemas.BifrostError{
			IsBifrostError: true,
			StatusCode:     intPtr(500),
			Error: &schemas.ErrorField{
				Message: fmt.Sprintf("copilot token exchange request failed: %s", err.Error()),
			},
		}}
	}

	if resp.StatusCode() != 200 {
		sc := resp.StatusCode()
		body := resp.Body()
		if len(body) > 512 {
			body = body[:512]
		}
		if tm.logger != nil {
			tm.logger.Warn("copilot: token exchange failed; OAuth token may be revoked or invalid",
				"status", sc)
		}

		tm.mu.Lock()
		// Only clear cached JWT on definitive auth failures (401/403).
		if sc == 401 || sc == 403 {
			tm.apiToken = ""
		} else if tm.apiToken != "" && time.Now().Before(tm.expiresAt) {
			t, b := tm.apiToken, tm.apiBase
			tm.mu.Unlock()
			return &tokenResult{token: t, apiBase: b}
		}
		tm.mu.Unlock()

		var allowFallbacks *bool
		if sc == 401 || sc == 403 {
			noFallback := false
			allowFallbacks = &noFallback
		}
		return &tokenResult{err: &schemas.BifrostError{
			IsBifrostError: true,
			StatusCode:     &sc,
			AllowFallbacks: allowFallbacks,
			Error: &schemas.ErrorField{
				Message: fmt.Sprintf("copilot token exchange returned %d: %s", sc, string(body)),
			},
		}}
	}

	var tokenResp CopilotTokenResponse
	if err := sonic.Unmarshal(resp.Body(), &tokenResp); err != nil {
		tm.mu.RLock()
		cached := tm.apiToken != "" && time.Now().Before(tm.expiresAt)
		t, b := tm.apiToken, tm.apiBase
		tm.mu.RUnlock()
		if cached {
			if tm.logger != nil {
				tm.logger.Warn("copilot: token exchange returned invalid JSON; using cached token",
					"error", err.Error())
			}
			return &tokenResult{token: t, apiBase: b}
		}
		return &tokenResult{err: &schemas.BifrostError{
			IsBifrostError: true,
			StatusCode:     intPtr(500),
			Error: &schemas.ErrorField{
				Message: fmt.Sprintf("failed to parse copilot token response: %s", err.Error()),
			},
		}}
	}

	if tokenResp.Token == "" {
		noFallback := false
		return &tokenResult{err: &schemas.BifrostError{
			IsBifrostError: true,
			StatusCode:     intPtr(401),
			AllowFallbacks: &noFallback,
			Error: &schemas.ErrorField{
				Message: "copilot token exchange returned empty token; ensure the OAuth access token is valid and the GitHub account has an active Copilot subscription",
			},
		}}
	}

	tm.mu.Lock()
	tm.apiToken = tokenResp.Token
	tm.expiresAt = time.Unix(tokenResp.ExpiresAt, 0)
	// Reset apiBase on every successful refresh so a stale dynamic host from a
	// previous exchange cannot leak through when the new response omits or
	// returns an invalid Endpoints.API.
	tm.apiBase = defaultAPIBaseURL
	if tokenResp.Endpoints.API != "" {
		if isValidCopilotAPIBase(tokenResp.Endpoints.API) {
			tm.apiBase = tokenResp.Endpoints.API
		} else if tm.logger != nil {
			tm.logger.Warn("copilot: token exchange returned untrusted API base URL; using default",
				"url", tokenResp.Endpoints.API, "default", defaultAPIBaseURL)
		}
	}
	t, b := tm.apiToken, tm.apiBase
	tm.mu.Unlock()

	return &tokenResult{token: t, apiBase: b}
}
