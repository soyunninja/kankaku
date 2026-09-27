import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { formatTodayLines } from "../domain/today-model.ts";
import type { TodayModel } from "../domain/today-model.ts";

export interface TodayScreenProps {
  load: () => TodayModel;
  onQuit: () => void;
  roots: string[];
}

/**
 * The Today screen: title, one aligned line per project (via
 * `formatTodayLines`, so nothing is reimplemented here), a total line, and
 * a footer with the key hints. `r` reloads through `load`; `q` calls
 * `onQuit`. Never writes anything to disk.
 */
export function TodayScreen({ load, onQuit, roots }: TodayScreenProps) {
  const [model, setModel] = useState<TodayModel>(load);

  useInput((input) => {
    if (input === "r") {
      setModel(load());
    } else if (input === "q") {
      onQuit();
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>{">_ kankaku · Today"}</Text>
      {model.rows.length === 0 ? (
        <Text>{`no work recorded today under ${roots.join(", ")}`}</Text>
      ) : (
        <Box flexDirection="column">
          {formatTodayLines(model.rows, model.total).map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
        </Box>
      )}
      <Text dimColor>r refresh · q quit</Text>
    </Box>
  );
}
