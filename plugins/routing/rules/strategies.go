package rules

// Target-selection strategies for routing rules, implemented as native v2 code
// against the plugins/routing engine (NOT a transplant of the old v1
// plugins/governance strategy files).
//
// This module owns three deterministic target-selection strategies that sit
// beside stock weighted-random selection:
//
//   - sticky-round-robin: a single active target serves up to StickyLimit
//     STRICTLY-SERVED requests before rotation advances. Rotation is advanced
//     only from the observed outcome (which target actually served), never at
//     scheduling time — this is the fix for 9router issue #948's hot-spotting,
//     where advancing before the serve outcome was known caused the pointer to
//     skip a target that failed and let a fallback serve instead.
//
//   - latency-based: track a per-target EWMA of observed latency and bias
//     selection toward the lowest measured target. Untested (cold-start)
//     targets are given priority and round-robined among themselves until they
//     accumulate a sample.
//
//   - circuit-breaker: after a threshold of consecutive-ish failures within a
//     cooldown window, a target is de-prioritized until the window elapses.
//
// Integration is intentionally narrow:
//   - Engine selection: engine.go's EvaluateRoutingRules calls
//     selectTargetForRule(ctx, rule) in place of the stock
//     selectWeightedTarget(rule.Targets). It dispatches by rule.Strategy.
//   - Outcome observation: RoutingPlugin.PostLLMHook (plugins/routing/main.go)
//     calls NotifyRuleServed once per logical request with the provider/model
//     that actually served, advancing sticky/latency/circuit state.
//
// All strategy state is in-memory and keyed by routing-rule ID, matching v2's
// decision not to persist per-request routing state.

import (
	"context"
	"os"
	"sync"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
	configstoreTables "github.com/maximhq/bifrost/framework/configstore/tables"
)

// Strategy values stored on TableRoutingRule.Strategy. The zero/empty value and
// "weighted" both mean stock weighted-random selection (engine default).
const (
	StrategyWeighted      = "weighted" // default; identical to upstream behavior
	StrategySticky        = "sticky-round-robin"
	StrategyLatency       = "latency-based"
	StrategyCircuitBreaker = "circuit-breaker"
)

// feature-flag env vars. Each strategy is individually gateable so it can be
// force-fallbacked to weighted without a code change (graceful degradation).
const (
	envSticky    = "BIFROST_FEATURE_STICKY_ROUTING"
	envLatency   = "BIFROST_FEATURE_LATENCY_ROUTING"
	envCircuit   = "BIFROST_FEATURE_CIRCUIT_BREAKER_ROUTING"
)

func envFlag(name string, def bool) bool {
	v, ok := os.LookupEnv(name)
	if !ok {
		return def
	}
	switch v {
	case "false", "0", "off", "no", "FALSE", "OFF", "NO":
		return false
	default:
		return true
	}
}

// selectTargetForRule is the single engine dispatch point. Stock weighted
// selection remains the default; a matched rule's Strategy (plus its feature
// flag) selects a deterministic strategy state machine instead.
func selectTargetForRule(ctx context.Context, rule *configstoreTables.TableRoutingRule) (configstoreTables.TableRoutingTarget, bool) {
	if rule == nil {
		return configstoreTables.TableRoutingTarget{}, false
	}
	switch rule.Strategy {
	case StrategySticky:
		if envFlag(envSticky, true) {
			return selectSticky(ctx, rule)
		}
	case StrategyLatency:
		if envFlag(envLatency, true) {
			return selectLatency(ctx, rule)
		}
	case StrategyCircuitBreaker:
		if envFlag(envCircuit, true) {
			return selectCircuit(ctx, rule)
		}
	}
	return selectWeightedTarget(rule.Targets)
}

// ---------------------------------------------------------------------------
// Sticky round-robin
// ---------------------------------------------------------------------------

type stickyState struct {
	mu            sync.Mutex
	currentIndex  int
	consecutive   int // requests the target at currentIndex has actually served
}

var stickyStates sync.Map // ruleID -> *stickyState

func stickyFor(ruleID string) *stickyState {
	if v, ok := stickyStates.Load(ruleID); ok {
		return v.(*stickyState)
	}
	actual, _ := stickyStates.LoadOrStore(ruleID, &stickyState{})
	return actual.(*stickyState)
}

func selectSticky(ctx context.Context, rule *configstoreTables.TableRoutingRule) (configstoreTables.TableRoutingTarget, bool) {
	targets := rule.Targets
	if len(targets) == 0 {
		return configstoreTables.TableRoutingTarget{}, false
	}
	st := stickyFor(rule.ID)
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.currentIndex < 0 || st.currentIndex >= len(targets) {
		st.currentIndex = 0
	}
	return targets[st.currentIndex], true
}

// advanceStickyRotation is called from NotifyRuleServed after a logical request
// completes with the (provider, model) that actually served. It reconciles the
// rotation pointer to the serving target and only advances once the serving
// target has been used StickyLimit consecutive times.
func advanceStickyRotation(rule *configstoreTables.TableRoutingRule, servedProvider, servedModel string) {
	if rule == nil || rule.StickyLimit < 1 {
		return
	}
	idx := targetIndex(rule.Targets, servedProvider, servedModel)
	if idx < 0 {
		return // served by a fallback/rule-level target not in Targets; leave state untouched
	}
	st := stickyFor(rule.ID)
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.currentIndex < 0 || st.currentIndex >= len(rule.Targets) {
		st.currentIndex = 0
	}
	if idx != st.currentIndex {
		// The pointer drifted from reality (e.g. a fresh/reset state, or a
		// concurrent interleave). Re-sync to whoever actually served and start
		// a fresh streak rather than incrementing blindly.
		st.currentIndex = idx
		st.consecutive = 1
	} else {
		st.consecutive++
	}
	if st.consecutive >= rule.StickyLimit {
		st.currentIndex = (st.currentIndex + 1) % len(rule.Targets)
		st.consecutive = 0
	}
}

// ---------------------------------------------------------------------------
// Latency-based (EWMA)
// ---------------------------------------------------------------------------

const ewmaAlpha = 0.2

type latencyPerTarget struct {
	mu          sync.Mutex
	ewmaNanos   float64
	sampleCount int
}

type latencyRuleState struct {
	mu      sync.Mutex
	targets map[string]*latencyPerTarget
	cursor  int
}

var latencyStates sync.Map // ruleID -> *latencyRuleState

func latencyFor(ruleID string) *latencyRuleState {
	if v, ok := latencyStates.Load(ruleID); ok {
		return v.(*latencyRuleState)
	}
	actual, _ := latencyStates.LoadOrStore(ruleID, &latencyRuleState{targets: map[string]*latencyPerTarget{}})
	return actual.(*latencyRuleState)
}

func selectLatency(ctx context.Context, rule *configstoreTables.TableRoutingRule) (configstoreTables.TableRoutingTarget, bool) {
	targets := rule.Targets
	if len(targets) == 0 {
		return configstoreTables.TableRoutingTarget{}, false
	}
	rs := latencyFor(rule.ID)

	// Separate tested from untested targets for the cold-start policy.
	rs.mu.Lock()
	var untested []int
	var lowestIdx int
	lowestEWMA := 0.0
	foundTested := false
	for i := range targets {
		ts := rs.targets[targetKey(targets[i])]
		if ts == nil || ts.sampleCount == 0 {
			untested = append(untested, i)
			continue
		}
		ts.mu.Lock()
		if !foundTested || ts.ewmaNanos < lowestEWMA {
			lowestEWMA = ts.ewmaNanos
			lowestIdx = i
			foundTested = true
		}
		ts.mu.Unlock()
	}
	pick := -1
	if len(untested) > 0 {
		// Cold start: round-robin among untested targets so a fresh target isn't
		// starved by whichever accumulated the first sample.
		pick = untested[rs.cursor%len(untested)]
		rs.cursor++
	} else if foundTested {
		pick = lowestIdx
	}
	rs.mu.Unlock()

	if pick < 0 {
		return selectWeightedTarget(targets)
	}
	return targets[pick], true
}

func recordLatencySample(rule *configstoreTables.TableRoutingRule, servedProvider, servedModel string, latency time.Duration, success bool) {
	if rule == nil {
		return
	}
	idx := targetIndex(rule.Targets, servedProvider, servedModel)
	if idx < 0 {
		return
	}
	rs := latencyFor(rule.ID)
	key := targetKey(rule.Targets[idx])
	rs.mu.Lock()
	ts := rs.targets[key]
	if ts == nil {
		ts = &latencyPerTarget{}
		rs.targets[key] = ts
	}
	rs.mu.Unlock()

	ts.mu.Lock()
	defer ts.mu.Unlock()
	if !success {
		return // failures are excluded from the latency average
	}
	if latency < 0 {
		return
	}
	if ts.sampleCount == 0 {
		ts.ewmaNanos = float64(latency)
	} else {
		ts.ewmaNanos = ewmaAlpha*float64(latency) + (1-ewmaAlpha)*ts.ewmaNanos
	}
	ts.sampleCount++
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

type circuitPerTarget struct {
	mu            sync.Mutex
	failures      int
	openedAtUnix  int64 // 0 = not open
}

type circuitRuleState struct {
	mu      sync.Mutex
	targets map[string]*circuitPerTarget
}

var circuitStates sync.Map // ruleID -> *circuitRuleState

func circuitFor(ruleID string) *circuitRuleState {
	if v, ok := circuitStates.Load(ruleID); ok {
		return v.(*circuitRuleState)
	}
	actual, _ := circuitStates.LoadOrStore(ruleID, &circuitRuleState{targets: map[string]*circuitPerTarget{}})
	return actual.(*circuitRuleState)
}

// selectCircuit chooses among targets whose breaker is closed (not open), else
// falls back to weighted.
func selectCircuit(ctx context.Context, rule *configstoreTables.TableRoutingRule) (configstoreTables.TableRoutingTarget, bool) {
	targets := rule.Targets
	if len(targets) == 0 {
		return configstoreTables.TableRoutingTarget{}, false
	}
	now := time.Now().Unix()
	cooldown := int64(rule.CircuitBreakerCooldownSeconds)
	if cooldown < 1 {
		cooldown = 60
	}
	rs := circuitFor(rule.ID)

	rs.mu.Lock()
	var closed []configstoreTables.TableRoutingTarget
	for _, t := range targets {
		key := targetKey(t)
		ct := rs.targets[key]
		if ct == nil {
			closed = append(closed, t) // never failed => available
			continue
		}
		ct.mu.Lock()
		opened := ct.openedAtUnix > 0 && (now-ct.openedAtUnix) < cooldown
		ct.mu.Unlock()
		if !opened {
			closed = append(closed, t)
		}
	}
	rs.mu.Unlock()

	if len(closed) == 0 {
		// All breakers open: fall back to weighted over the original set rather
		// than returning nothing (keep serving under total failure).
		return selectWeightedTarget(targets)
	}
	return selectWeightedTarget(closed)
}

// recordCircuitResult records a success/failure and opens the breaker after
// the threshold of consecutive failures is reached.
func recordCircuitResult(rule *configstoreTables.TableRoutingRule, servedProvider, servedModel string, success bool) {
	if rule == nil {
		return
	}
	idx := targetIndex(rule.Targets, servedProvider, servedModel)
	if idx < 0 {
		return
	}
	key := targetKey(rule.Targets[idx])
	rs := circuitFor(rule.ID)
	rs.mu.Lock()
	ct := rs.targets[key]
	if ct == nil {
		ct = &circuitPerTarget{}
		rs.targets[key] = ct
	}
	rs.mu.Unlock()

	thresh := rule.CircuitBreakerThreshold
	if thresh < 1 {
		thresh = 5
	}
	ct.mu.Lock()
	defer ct.mu.Unlock()
	if success {
		ct.failures = 0
		ct.openedAtUnix = 0
		return
	}
	ct.failures++
	if ct.failures >= thresh && ct.openedAtUnix == 0 {
		ct.openedAtUnix = time.Now().Unix()
		ct.failures = 0
	}
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// targetKey builds the identity for a target within rule-internal state maps,
// using the (provider, model) pair.
func targetKey(t configstoreTables.TableRoutingTarget) string {
	p, m := "", ""
	if t.Provider != nil {
		p = *t.Provider
	}
	if t.Model != nil {
		m = *t.Model
	}
	return p + "\x00" + m
}

// targetIndex returns the index of the target matching servedProvider/servedModel,
// or -1 if none match.
func targetIndex(targets []configstoreTables.TableRoutingTarget, servedProvider, servedModel string) int {
	for i, t := range targets {
		p, m := "", ""
		if t.Provider != nil {
			p = *t.Provider
		}
		if t.Model != nil {
			m = *t.Model
		}
		if p == servedProvider && m == servedModel {
			return i
		}
	}
	return -1
}

// dedupKey notes (on the request context) that a given observe action has
// already run for this logical request, so PostLLMHook (which fires once per
// attempt including fallbacks) only advances state once per logical request.
type stratsContextMarker string

const stratObservedMarker stratsContextMarker = "bf-routing-strategy-observed"

func markObserved(ctx context.Context) {
	if cc, ok := ctx.(*schemas.BifrostContext); ok {
		cc.SetValue(schemas.BifrostContextKey(stratObservedMarker), true)
	}
}

func alreadyObserved(ctx context.Context) bool {
	if cc, ok := ctx.(*schemas.BifrostContext); ok {
		v, _ := cc.Value(schemas.BifrostContextKey(stratObservedMarker)).(bool)
		return v
	}
	return false
}

// NotifyRuleServed is called from RoutingPlugin.PostLLMHook once per logical
// request (deduped), after the response is known, to feed the observed outcome
// into whichever strategy the matched rule uses. latency is meaningful only for
// latency-based rules.
func NotifyRuleServed(ctx context.Context, rule *configstoreTables.TableRoutingRule, servedProvider, servedModel string, latency time.Duration, success bool) {
	if rule == nil || alreadyObserved(ctx) {
		return
	}
	markObserved(ctx)

	switch rule.Strategy {
	case StrategySticky:
		if envFlag(envSticky, true) {
			advanceStickyRotation(rule, servedProvider, servedModel)
		}
	case StrategyLatency:
		if envFlag(envLatency, true) {
			recordLatencySample(rule, servedProvider, servedModel, latency, success)
		}
	case StrategyCircuitBreaker:
		if envFlag(envCircuit, true) {
			recordCircuitResult(rule, servedProvider, servedModel, success)
		}
	}
}
