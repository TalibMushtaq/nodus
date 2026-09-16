import { StyleSheet } from "react-native";

// Shared styles for the Nodus mobile screens. Extracted from the original
// single-screen App so each navigator screen can reuse the same visual language.
export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 16, paddingBottom: 48 },
  title: { fontSize: 22, fontWeight: "700", marginBottom: 4 },
  hint: { color: "#666", marginVertical: 2 },
  section: { borderTopWidth: 1, borderTopColor: "#eee", paddingVertical: 12 },
  sectionTitle: { fontSize: 16, fontWeight: "600", marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 6,
    padding: 8,
    marginBottom: 8,
  },
  radioRow: { marginVertical: 2 },
  buttonRow: { flexDirection: "row", justifyContent: "space-between", marginVertical: 4 },
  nodeLabel: { color: "#111", paddingVertical: 4 },
  nodeSelected: { color: "#1a73e8", fontWeight: "600" },
  mono: {
    marginTop: 8,
    color: "#333",
    fontSize: 12,
    backgroundColor: "#f5f5f5",
    padding: 8,
    borderRadius: 4,
  },
  code: {
    marginTop: 8,
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: 2,
    color: "#111",
  },
  spacer: { height: 8 },
  error: { color: "#c0392b", marginTop: 8 },
  ok: { color: "#27ae60", marginTop: 8 },
});
