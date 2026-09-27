import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { Table } from "../src/ui/components/table.tsx";

interface Row {
  id: string;
  name: string;
  work: string;
}

const columns = [
  { key: "name", header: "project", width: 10 },
  { key: "work", header: "work", width: 6, align: "right" as const },
];

const rows: Row[] = [
  { id: "a", name: "kankaku", work: "1h02m" },
  { id: "b", name: "kankaku-tui", work: "31m" },
];

test("renders a header row and one row per item, right-aligning a right column", () => {
  const { lastFrame } = render(<Table columns={columns} rows={rows} rowKey={(row: Row) => row.id} cell={(row: Row, key: string) => (row as unknown as Record<string, string>)[key] ?? ""} />);
  const lines = (lastFrame() ?? "").split("\n");
  assert.equal(lines[0]?.includes("project"), true);
  assert.equal(lines[0]?.includes("work"), true);
  assert.equal(lines[1]?.includes("kankaku"), true);
  assert.equal(lines[1]?.includes(" 1h02m"), true);
});

test("marks the selected row with a visible marker, not colour alone", () => {
  const { lastFrame } = render(
    <Table
      columns={columns}
      rows={rows}
      rowKey={(row: Row) => row.id}
      cell={(row: Row, key: string) => (row as unknown as Record<string, string>)[key] ?? ""}
      selectedIndex={1}
    />,
  );
  const lines = (lastFrame() ?? "").split("\n");
  assert.equal(lines[1]?.startsWith("  "), true);
  assert.equal(lines[2]?.startsWith("› "), true);
});

test("truncates a cell longer than its column width with an ellipsis", () => {
  const longRows: Row[] = [{ id: "a", name: "a-very-long-project-name", work: "1m" }];
  const { lastFrame } = render(
    <Table columns={columns} rows={longRows} rowKey={(row: Row) => row.id} cell={(row: Row, key: string) => (row as unknown as Record<string, string>)[key] ?? ""} />,
  );
  const line = (lastFrame() ?? "").split("\n")[1] ?? "";
  assert.equal(line.includes("…"), true);
});

test("shows the empty text when there are no rows", () => {
  const { lastFrame } = render(
    <Table columns={columns} rows={[]} rowKey={(row: Row) => row.id} cell={() => ""} emptyText="no rows" />,
  );
  assert.equal((lastFrame() ?? "").includes("no rows"), true);
});
