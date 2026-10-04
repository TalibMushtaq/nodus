package reset

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
)

// This file holds the guardrails for the factory reset. `reset.Run` destroys
// the SQLite database, a Redis database index, and a directory on disk, and it
// takes all three targets from the environment. Without checks, a single
// mistyped BUFFER_DIR pointed at `/` or `$HOME` deletes that tree, and a reset
// run against a database the Relay is still serving drops the schema underneath
// a live server. The checks here are deliberately asymmetric: anything with no
// legitimate use as a buffer path is refused outright, and the one guardrail an
// operator may have a real reason to bypass (a live connection, because they
// know the server really is stopped) is an explicit flag rather than a silent
// behavior.

// systemDirs are top-level directories that must never *be* the buffer path.
// os.RemoveAll is recursive, so naming one of these as BUFFER_DIR would delete
// the whole subtree. Being a *parent* is fine and normal, which is why
// /tmp/nodus-relay/buffer (the default) and /var/lib/nodus/buffer are allowed.
var systemDirs = map[string]bool{
	"/bin": true, "/boot": true, "/dev": true, "/etc": true, "/home": true,
	"/lib": true, "/lib32": true, "/lib64": true, "/libx32": true, "/media": true,
	"/mnt": true, "/opt": true, "/proc": true, "/root": true, "/run": true,
	"/sbin": true, "/srv": true, "/sys": true, "/tmp": true, "/usr": true,
	"/var": true, "/Users": true,
}

// forbiddenSymlinkTargets are the trees that are never a legitimate buffer
// location even as a parent, so a path that *resolves* into one of them is
// refused outright. This is a subset of systemDirs on purpose: /tmp, /var, /opt,
// /srv, /mnt, and /media are all normal places to keep a data volume, and the
// default buffer path lives under /tmp, so those are only refused when named
// directly. The remainder are the trees where an unexpected symlink would do
// real damage: the OS, its libraries, its devices, and its process table.
var forbiddenSymlinkTargets = []string{
	"/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32",
	"/proc", "/sbin", "/sys", "/usr", "/Users",
}

// minBufferDirDepth is the minimum number of path components below the root.
// The default is <tmpdir>/nodus-relay/buffer; requiring at least two keeps a
// bare top-level directory such as /data or /app from being treated as a buffer
// directory when the operator meant to name a subdirectory.
const minBufferDirDepth = 2

// validateBufferDir refuses a BUFFER_DIR that os.RemoveAll must not be pointed
// at. It is checked before anything is dropped, so a bad path aborts the whole
// reset with the database and Redis untouched.
func validateBufferDir(path string) error {
	if path == "" {
		return fmt.Errorf("refusing to reset: BUFFER_DIR is empty")
	}
	if !filepath.IsAbs(path) {
		return fmt.Errorf("refusing to reset: BUFFER_DIR %q is not an absolute path", path)
	}
	cleaned := filepath.Clean(path)
	if cleaned == "/" {
		return fmt.Errorf("refusing to reset: BUFFER_DIR is the filesystem root")
	}
	if systemDirs[cleaned] {
		return fmt.Errorf("refusing to reset: BUFFER_DIR %q is a system directory", cleaned)
	}
	if parts := strings.Split(strings.Trim(cleaned, string(filepath.Separator)), string(filepath.Separator)); len(parts) < minBufferDirDepth {
		return fmt.Errorf("refusing to reset: BUFFER_DIR %q is too shallow; use a dedicated subdirectory such as /var/lib/nodus/buffer", cleaned)
	}
	// The home directory and anything containing it. As with the cwd check, the
	// question is whether home lives inside the candidate.
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		if isWithin(filepath.Clean(home), cleaned) {
			return fmt.Errorf("refusing to reset: BUFFER_DIR %q contains the home directory %q", cleaned, home)
		}
	}
	// The reset process's own working directory, and any directory containing it,
	// would be removed out from under the running binary. Note the argument
	// order: we ask whether the cwd lives inside the candidate, which is what
	// "would deleting this take out the running process" means.
	if cwd, err := os.Getwd(); err == nil && cwd != "" {
		if isWithin(filepath.Clean(cwd), cleaned) {
			return fmt.Errorf("refusing to reset: BUFFER_DIR %q contains the working directory %q", cleaned, cwd)
		}
	}
	// A symlinked parent is followed by RemoveAll even though a symlinked leaf is
	// not, so resolve the deepest part of the path that exists and re-check it:
	// BUFFER_DIR=/data/nodus/buffer with nodus -> /etc must not delete /etc/buffer.
	// Every path under a system directory is refused, not only the directory
	// itself, because the resolved leaf is normally a subdirectory of the target.
	if resolved, err := resolveExistingPrefix(cleaned); err == nil && resolved != cleaned {
		if resolved == "/" {
			return fmt.Errorf("refusing to reset: BUFFER_DIR %q resolves to the filesystem root", cleaned)
		}
		for _, sysDir := range forbiddenSymlinkTargets {
			if isWithin(resolved, sysDir) {
				return fmt.Errorf("refusing to reset: BUFFER_DIR %q resolves through a symlink into the system directory %q", cleaned, sysDir)
			}
		}
	}
	return nil
}

// isWithin reports whether path is ancestor or lives under it.
func isWithin(path, ancestor string) bool {
	rel, err := filepath.Rel(ancestor, path)
	if err != nil {
		return false
	}
	return rel == "." || (!strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != "..")
}

// resolveExistingPrefix resolves symlinks on the longest existing prefix of path
// and re-appends the components that do not exist yet. Returns path unchanged if
// nothing along it can be resolved.
func resolveExistingPrefix(path string) (string, error) {
	remainder := ""
	current := path
	for {
		resolved, err := filepath.EvalSymlinks(current)
		if err == nil {
			if remainder == "" {
				return resolved, nil
			}
			return filepath.Join(resolved, remainder), nil
		}
		parent := filepath.Dir(current)
		if parent == current {
			return path, nil
		}
		remainder = filepath.Join(filepath.Base(current), remainder)
		current = parent
	}
}

// DescribeTarget renders exactly what the reset is about to destroy, with
// credentials stripped. The confirmation prompt shows this so an operator whose
// environment points at the wrong database file, Redis index, or buffer path
// sees the mistake before anything is deleted.
func DescribeTarget(cfg *config.Config) string {
	var b strings.Builder
	b.WriteString("[relay]   - sqlite:   " + cfg.DBPath + "\n")
	b.WriteString("[relay]   - redis:    " + safeRedisTarget(cfg.RedisURL) + "\n")
	b.WriteString("[relay]   - buffer:   " + cfg.BufferDir + "\n")
	return b.String()
}

// safeRedisTarget reduces a REDIS_URL to host:port and the database index, which
// is the part that decides whose keys get flushed.
func safeRedisTarget(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return "unparseable REDIS_URL (refusing to show it verbatim)"
	}
	index := strings.TrimPrefix(parsed.Path, "/")
	if index == "" {
		index = "0"
	}
	return fmt.Sprintf("%s db %s", parsed.Host, index)
}
