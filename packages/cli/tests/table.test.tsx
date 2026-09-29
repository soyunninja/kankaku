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

function manyRows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: `r${index}`, name: `project-${index}`, work: `${index}m` }));
}

test("renders every row and no indicators when everything fits within maxRows", () => {
  const { lastFrame } = render(
    <Table columns={columns} rows={manyRows(5)} rowKey={(row: Row) => row.id} cell={(row: Row, key: string) => (row as unknown as Record<string, string>)[key] ?? ""} maxRows={10} />,
  );
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("project-0"), true);
  assert.equal(frame.includes("project-4"), true);
  assert.equal(frame.includes("more"), false);
});

test("windows to maxRows and shows a '↓ N more' indicator when the selection is near the top", () => {
  const { lastFrame } = render(
    <Table
      columns={columns}
      rows={manyRows(40)}
      rowKey={(row: Row) => row.id}
      cell={(row: Row, key: string) => (row as unknown as Record<string, string>)[key] ?? ""}
      selectedIndex={0}
      maxRows={10}
    />,
  );
  const lines = (lastFrame() ?? "").split("\n");
  assert.equal(lines.includes("› project-0      0m"), true);
  assert.equal(lines.some((line) => line.includes("↓") && line.includes("more")), true);
  assert.equal(lines.some((line) => line.includes("↑") && line.includes("more")), false);
  // header + maxRows body lines (data rows + one indicator line)
  assert.equal(lines.length, 1 + 10);
});

test("shows both '↑ N more' and '↓ N more' when the selection sits in the middle", () => {
  const { lastFrame } = render(
    <Table
      columns={columns}
      rows={manyRows(40)}
      rowKey={(row: Row) => row.id}
      cell={(row: Row, key: string) => (row as unknown as Record<string, string>)[key] ?? ""}
      selectedIndex={20}
      maxRows={10}
    />,
  );
  const lines = (lastFrame() ?? "").split("\n");
  assert.equal(lines.some((line) => line.includes("↑") && line.includes("more")), true);
  assert.equal(lines.some((line) => line.includes("↓") && line.includes("more")), true);
  assert.equal(lines.some((line) => line.includes("project-20")), true);
  assert.equal(lines.length, 1 + 10);
});

test("shows only '↑ N more' when the selection is near the bottom", () => {
  const { lastFrame } = render(
    <Table
      columns={columns}
      rows={manyRows(40)}
      rowKey={(row: Row) => row.id}
      cell={(row: Row, key: string) => (row as unknown as Record<string, string>)[key] ?? ""}
      selectedIndex={39}
      maxRows={10}
    />,
  );
  const lines = (lastFrame() ?? "").split("\n");
  assert.equal(lines.some((line) => line.includes("↑") && line.includes("more")), true);
  assert.equal(lines.some((line) => line.includes("↓") && line.includes("more")), false);
  assert.equal(lines.some((line) => line.includes("project-39")), true);
});

test("asks rowColor for each visible row and never for a row outside the window", () => {
  const asked: string[] = [];
  const many: Row[] = Array.from({ length: 10 }, (_, index) => ({ id: `r${index}`, name: `n${index}`, work: "1m" }));
  render(
    <Table
      columns={columns}
      rows={many}
      rowKey={(row: Row) => row.id}
      cell={(row: Row, key: string) => (row as unknown as Record<string, string>)[key] ?? ""}
      rowColor={(row: Row) => {
        asked.push(row.id);
        return undefined;
      }}
      selectedIndex={0}
      maxRows={4}
    />,
  );
  assert.deepEqual([...new Set(asked)], ["r0", "r1", "r2"]);
});
