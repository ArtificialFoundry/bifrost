package logstore

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/maximhq/bifrost/framework/queryscope"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// withCeiling returns ctx bounding idCol to allowed on charts, the way the
// enterprise DAC scope does for a team / business-unit / customer-data caller.
func withCeiling(ctx context.Context, idCol string, allowed ...string) context.Context {
	return queryscope.WithDimensionScope(ctx, func(col string) ([]string, bool) {
		if col != idCol {
			return nil, false
		}
		return allowed, true
	})
}

// rankingRequestsByID indexes a ranking's request counts and names by id and
// sums its rows.
func rankingRequestsByID(res *DimensionRankingResult) (map[string]int64, map[string]string, int64) {
	requests := make(map[string]int64, len(res.Rankings))
	names := make(map[string]string, len(res.Rankings))
	var sum int64
	for _, r := range res.Rankings {
		requests[r.ID] = r.TotalRequests
		names[r.ID] = r.Name
		sum += r.TotalRequests
	}
	return requests, names, sum
}

// otherRankingStores runs fn against SQLite, and against Postgres when one is
// reachable, since the two fan out the team arrays with different SQL.
func otherRankingStores(t *testing.T, fn func(t *testing.T, store *RDBLogStore, db *gorm.DB)) {
	t.Run("sqlite", func(t *testing.T) {
		store := newTestSQLiteStore(t)
		fn(t, store, store.db)
	})
	t.Run("postgres", func(t *testing.T) {
		store, db := setupPerfTestDB(t)
		fn(t, store, db)
	})
}

// TestDimensionRankings_HiddenTeamsGoToOther verifies a fanned-out ranking
// under a ceiling puts the attributions the caller may not be shown into one
// Other row instead of dropping them, without naming the hidden team, so the
// rows still sum to TotalAttributedRequests and actual stays the full count.
func TestDimensionRankings_HiddenTeamsGoToOther(t *testing.T) {
	otherRankingStores(t, func(t *testing.T, store *RDBLogStore, db *gorm.DB) {
		now := time.Now().UTC()
		insertTeamBULog(t, db, now, "u-1", "", "", `["t-a","t-b"]`, `["Team A","Team B"]`, "", "", "", "")
		insertTeamBULog(t, db, now, "u-1", "t-a", "Team A", "", "", "", "", "", "")
		insertTeamBULog(t, db, now, "u-2", "", "", `["t-c"]`, `["Team C"]`, "", "", "", "")
		insertTeamBULog(t, db, now, "u-3", "", "", "", "", "", "", "", "")

		start, end := now.Add(-time.Hour), now.Add(time.Hour)
		ctx := withCeiling(context.Background(), "team_id", "t-a")
		res, err := store.GetDimensionRankings(ctx, SearchFilters{StartTime: &start, EndTime: &end}, RankingDimensionTeam)
		require.NoError(t, err)

		requests, names, sum := rankingRequestsByID(res)
		assert.Equal(t, int64(2), requests["t-a"])
		assert.Equal(t, int64(2), requests[otherDimensionID], "t-b's attribution and the t-c request")
		assert.Equal(t, int64(1), requests[unassignedDimensionID])
		assert.NotContains(t, requests, "t-b")
		assert.NotContains(t, requests, "t-c")
		assert.Equal(t, otherDimensionName, names[otherDimensionID], "the Other row never carries a hidden team's name")
		assert.Equal(t, int64(4), res.TotalActualRequests, "actual counts every request the caller can read")
		assert.Equal(t, int64(5), res.TotalAttributedRequests)
		assert.Equal(t, res.TotalAttributedRequests, sum, "rows sum to attributed")
	})
}

// TestDimensionRankings_HiddenUsersGoToOther verifies a single-owner ranking
// under a ceiling reconciles: shown + Other + Unassigned equals the request
// count, so the tab's total matches the rows.
func TestDimensionRankings_HiddenUsersGoToOther(t *testing.T) {
	otherRankingStores(t, func(t *testing.T, store *RDBLogStore, db *gorm.DB) {
		now := time.Now().UTC()
		insertTeamBULog(t, db, now, "u-1", "", "", "", "", "", "", "", "")
		insertTeamBULog(t, db, now, "u-2", "", "", "", "", "", "", "", "")
		insertTeamBULog(t, db, now, "u-2", "", "", "", "", "", "", "", "")
		insertTeamBULog(t, db, now, "", "", "", "", "", "", "", "", "")

		start, end := now.Add(-time.Hour), now.Add(time.Hour)
		ctx := withCeiling(context.Background(), "user_id", "u-1")
		res, err := store.GetDimensionRankings(ctx, SearchFilters{StartTime: &start, EndTime: &end}, RankingDimensionUser)
		require.NoError(t, err)

		requests, _, sum := rankingRequestsByID(res)
		assert.Equal(t, int64(1), requests["u-1"])
		assert.Equal(t, int64(2), requests[otherDimensionID])
		assert.Equal(t, int64(1), requests[unassignedDimensionID])
		assert.NotContains(t, requests, "u-2")
		assert.Equal(t, res.Rankings[0].ID, otherDimensionID, "Other sorts by its request count like any row")
		assert.Equal(t, int64(4), res.TotalActualRequests)
		assert.Equal(t, int64(4), res.TotalAttributedRequests)
		assert.Equal(t, res.TotalActualRequests, sum)
	})
}

// TestDimensionRankings_EmptyCeilingPutsAllOwnedInOther verifies a bounded
// ceiling with nothing allowed still returns the caller's rows, all in Other
// and Unassigned.
func TestDimensionRankings_EmptyCeilingPutsAllOwnedInOther(t *testing.T) {
	otherRankingStores(t, func(t *testing.T, store *RDBLogStore, db *gorm.DB) {
		now := time.Now().UTC()
		insertTeamBULog(t, db, now, "u-1", "", "", "", "", "", "", "", "")
		insertTeamBULog(t, db, now, "", "", "", "", "", "", "", "", "")

		start, end := now.Add(-time.Hour), now.Add(time.Hour)
		res, err := store.GetDimensionRankings(withCeiling(context.Background(), "user_id"), SearchFilters{StartTime: &start, EndTime: &end}, RankingDimensionUser)
		require.NoError(t, err)

		requests, _, sum := rankingRequestsByID(res)
		assert.Equal(t, map[string]int64{otherDimensionID: 1, unassignedDimensionID: 1}, requests)
		assert.Equal(t, res.TotalActualRequests, sum)
	})
}

// TestDimensionRankings_OtherCarriesTrend verifies the Other row compares
// against the previous period's hidden traffic like any other row.
func TestDimensionRankings_OtherCarriesTrend(t *testing.T) {
	otherRankingStores(t, func(t *testing.T, store *RDBLogStore, db *gorm.DB) {
		now := time.Now().UTC()
		insertTeamBULog(t, db, now.Add(-90*time.Minute), "u-2", "", "", "", "", "", "", "", "")
		insertTeamBULog(t, db, now, "u-2", "", "", "", "", "", "", "", "")
		insertTeamBULog(t, db, now, "u-3", "", "", "", "", "", "", "", "")

		start, end := now.Add(-time.Hour), now.Add(time.Hour)
		ctx := withCeiling(context.Background(), "user_id", "u-1")
		res, err := store.GetDimensionRankings(ctx, SearchFilters{StartTime: &start, EndTime: &end}, RankingDimensionUser)
		require.NoError(t, err)

		require.Len(t, res.Rankings, 1)
		other := res.Rankings[0]
		assert.Equal(t, otherDimensionID, other.ID)
		assert.Equal(t, int64(2), other.TotalRequests)
		assert.True(t, other.Trend.HasPreviousPeriod)
		assert.InDelta(t, 100.0, other.Trend.RequestsTrend, 0.001)
	})
}

// TestDimensionRankings_NoCeilingHasNoOther verifies callers without a
// ceiling (all-data, OSS) never see an Other row.
func TestDimensionRankings_NoCeilingHasNoOther(t *testing.T) {
	store := newTestSQLiteStore(t)
	now := time.Now().UTC()
	insertTeamBULog(t, store.db, now, "u-"+uuid.NewString(), "", "", "", "", "", "", "", "")

	start, end := now.Add(-time.Hour), now.Add(time.Hour)
	res, err := store.GetDimensionRankings(context.Background(), SearchFilters{StartTime: &start, EndTime: &end}, RankingDimensionUser)
	require.NoError(t, err)
	requests, _, _ := rankingRequestsByID(res)
	assert.NotContains(t, requests, otherDimensionID)
}
