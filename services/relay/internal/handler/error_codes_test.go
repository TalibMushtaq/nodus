package handler

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require" //nolint:depguard
)

// errorCodesEmittedByRelay pins the set of `error_code` values the Relay puts on
// the wire, and requires each one to be in the `ErrorCode` enum in
// `packages/protocol/src/errors.ts`.
//
// That enum is a closed zod enum, so a code it omits makes `ErrorPayloadSchema`
// reject an envelope the client should have been able to read — the failure lands
// on the client, with an error about the shape of a message rather than about the
// thing that actually went wrong. Nothing in either language catches that by
// itself: the Go compiler cannot see the TypeScript list, and the TypeScript
// compiler cannot see what the Relay sends. This test is the join.
//
// The codes are read out of the source with the AST rather than a regex, so
// reformatting, moving a handler, or building the string differently is not
// mistaken for a change. Adding a new emission is meant to fail here until
// `errors.ts` and `docs/protocol/message-catalog.md` list it too.
func TestErrorCodesEmittedByRelayAreAllDocumented(t *testing.T) {
	emitted := errorCodeLiterals(t, ".")
	require.NotEmpty(t, emitted, "no error_code literals found; the walk is broken")

	// Declared in packages/protocol/src/errors.ts as `KEY: "value",` inside the
	// ErrorCodes object, and again in the ErrorCodeSchema enum. Both must contain
	// the value, since the object is what consumers read and the schema is what
	// they validate against.
	protocol, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "protocol", "src", "errors.ts"))
	require.NoError(t, err, "could not read packages/protocol/src/errors.ts")

	catalogPath := filepath.Join("..", "..", "..", "..", "docs", "protocol", "message-catalog.md")
	catalog, err := os.ReadFile(catalogPath)
	require.NoError(t, err, "could not read the message catalog")

	for code := range emitted {
		// require.Contains would print the whole file on failure, which is a lot of
		// noise for "one string is missing".
		if !strings.Contains(string(protocol), `"`+code+`"`) {
			t.Errorf("the relay emits error_code %q, which is not in the ErrorCode enum; "+
				"a client validating ErrorPayloadSchema would reject the envelope. "+
				"Add it to ErrorCodes and ErrorCodeSchema in packages/protocol/src/errors.ts", code)
		}
		if !strings.Contains(string(catalog), "`"+code+"`") {
			t.Errorf("the relay emits error_code %q, which the message catalog does not document", code)
		}
	}

	// And the other direction: a documented code that the Relay no longer sends
	// is dead vocabulary. Only worth flagging, not worth failing on, because the
	// generic codes are legitimately emitted by other peers.
	t.Logf("relay error_code values: %d", len(emitted))
}

// errorCodeLiterals returns every `error_code: "literal"` in the package's Go
// files, keyed by the literal.
func errorCodeLiterals(t *testing.T, dir string) map[string]struct{} {
	t.Helper()

	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, dir, nil, 0)
	require.NoError(t, err)

	found := make(map[string]struct{})
	for _, pkg := range pkgs {
		for _, file := range pkg.Files {
			ast.Inspect(file, func(n ast.Node) bool {
				kv, ok := n.(*ast.KeyValueExpr)
				if !ok {
					return true
				}
				// The key is the string literal "error_code" in a map literal, but
				// accept a bare identifier too so a struct field keyed by a
				// constant is still caught.
				var keyName string
				switch key := kv.Key.(type) {
				case *ast.Ident:
					keyName = key.Name
				case *ast.BasicLit:
					if key.Kind == token.STRING {
						keyName, _ = strconv.Unquote(key.Value)
					}
				}
				if keyName != "error_code" {
					return true
				}
				lit, ok := kv.Value.(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					return true
				}
				value, err := strconv.Unquote(lit.Value)
				if err == nil && value != "" {
					found[value] = struct{}{}
				}
				return true
			})
		}
	}
	return found
}
