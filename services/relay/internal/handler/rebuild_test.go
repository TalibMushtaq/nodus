package handler

import "testing"

func TestValidateRebuildReason(t *testing.T) {
	cases := []struct {
		name    string
		reason  string
		wantErr bool
	}{
		{"admin", "admin", false},
		{"restore", "restore", false},
		{"schema_mismatch", "schema_mismatch", false},
		{"empty", "", true},
		{"misspelled", "schema-mismatch", true},
		{"unknown", "maintenance", true},
		{"case sensitive", "ADMIN", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateRebuildReason(tc.reason)
			if (err != nil) != tc.wantErr {
				t.Errorf("validateRebuildReason(%q) err = %v, wantErr %v", tc.reason, err, tc.wantErr)
			}
		})
	}
}
