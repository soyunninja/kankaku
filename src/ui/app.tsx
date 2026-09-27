import { useApp } from "ink";
import { TodayScreen } from "./today-screen.tsx";
import type { TodayModel } from "../domain/today-model.ts";

export interface AppProps {
  load: () => TodayModel;
  roots: string[];
}

/** Mounts {@link TodayScreen}, wiring `q` to Ink's own `exit()`. */
export function App({ load, roots }: AppProps) {
  const { exit } = useApp();
  return <TodayScreen load={load} onQuit={() => exit()} roots={roots} />;
}
