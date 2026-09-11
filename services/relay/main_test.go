package main

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/lib/pq"
)

func TestPermanentDBError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"pgx auth failure", &pgconn.PgError{Code: "28P01"}, true},
		{"pgx invalid authorization", &pgconn.PgError{Code: "28000"}, true},
		{"pgx missing database", &pgconn.PgError{Code: "3D000"}, true},
		{"pq auth failure", &pq.Error{Code: "28P01"}, true},
		{"pq missing database", &pq.Error{Code: "3D000"}, true},
		// Transient conditions must keep their retry budget.
		{"pgx starting up", &pgconn.PgError{Code: "57P03"}, false},
		{"pgx too many connections", &pgconn.PgError{Code: "53300"}, false},
		{"pq starting up", &pq.Error{Code: "57P03"}, false},
		{"plain error", errors.New("connection refused"), false},
		{"wrapped permanent", fmt.Errorf("running migrations: %w", &pq.Error{Code: "28P01"}), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := permanentDBError(tc.err); got != tc.want {
				t.Fatalf("permanentDBError(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}
