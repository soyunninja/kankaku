import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { formatMinutes } from "../domain/today-model.ts";
import type { TaskRow, TasksModel } from "../domain/tasks-model.ts";

export interface TasksScreenProps {
  load: (options: { all: boolean }) => TasksModel;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

function formatRow(row: TaskRow): string {
  const clientPart = row.clientName !== undefined ? `  client:${row.clientName}` : "";
  const hubTaskPart = row.hubTaskTitle !== undefined ? `  task:${row.hubTaskTitle}` : "";
  return `${row.time}  ${row.project}${clientPart}${hubTaskPart}  wall ${formatMinutes(row.wallMs)}  work ${formatMinutes(row.workMs)}  ${formatCost(row.cost)}  ${row.prompt}`;
}

/**
 * The Tasks screen: title, one row per task (via kankaku's own `buildTasks`
 * through `domain/tasks-model.ts`, never reimplemented here), and a
 * footer. `a` toggles between today's tasks and every task; `↑↓` move the
 * selection highlight; `r` reloads with the current today/all flag. Never
 * writes anything to disk.
 */
export function TasksScreen({ load }: TasksScreenProps) {
  // Tracked alongside `all` state so rapid key presses (two `useInput`
  // dispatches within the same batched render) always read the latest
  // toggle value rather than a stale render closure.
  const allRef = useRef(false);
  const [all, setAll] = useState(false);
  const [model, setModel] = useState<TasksModel>(() => load({ all: false }));
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (input === "a") {
      const nextAll = !allRef.current;
      allRef.current = nextAll;
      setAll(nextAll);
      setModel(load({ all: nextAll }));
      setSelected(0);
    } else if (input === "r") {
      setModel(load({ all: allRef.current }));
    } else if (key.downArrow) {
      setSelected((index) => Math.min(index + 1, Math.max(model.rows.length - 1, 0)));
    } else if (key.upArrow) {
      setSelected((index) => Math.max(index - 1, 0));
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>{">_ kankaku · Tasks"}</Text>
      {model.rows.length === 0 ? (
        <Text>no tasks</Text>
      ) : (
        <Box flexDirection="column">
          {model.rows.map((row, index) => (
            <Text key={row.id} bold={index === selected}>
              {`${index === selected ? "› " : "  "}${formatRow(row)}`}
            </Text>
          ))}
        </Box>
      )}
      <Text dimColor>{`a today/all · ↑↓ select · r refresh${all ? " (all)" : " (today)"}`}</Text>
    </Box>
  );
}
