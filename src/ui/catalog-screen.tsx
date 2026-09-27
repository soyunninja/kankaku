import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { formatMinutes } from "../domain/today-model.ts";
import type { CatalogClientRow, CatalogModel } from "../domain/catalog-model.ts";

export interface CatalogScreenProps {
  load: () => CatalogModel;
  refresh: () => Promise<CatalogModel>;
}

function ClientBlock({ client }: { client: CatalogClientRow }) {
  return (
    <Box flexDirection="column">
      <Text bold>{`${client.name} (${client.code})`}</Text>
      {client.projects.length === 0 ? (
        <Text dimColor>{"  (no projects)"}</Text>
      ) : (
        client.projects.map((project) => (
          <Text key={project.id}>{`  ${project.name}  open ${project.openCount}  doing ${project.doingCount}`}</Text>
        ))
      )}
    </Box>
  );
}

/**
 * The Catalog screen: hub clients and their projects, with open/doing hub
 * task counts, via `adapters/hub.ts` (`CachedCatalog`, never
 * reimplemented). Without hub credentials, or with no cache yet, shows a
 * one-line note instead. `r` refreshes against the hub. Never writes
 * anything to disk itself — the cache write is `CachedCatalog`'s own.
 */
export function CatalogScreen({ load, refresh }: CatalogScreenProps) {
  const [model, setModel] = useState<CatalogModel>(load);
  const [refreshing, setRefreshing] = useState(false);

  useInput((input) => {
    if (input === "r" && !refreshing) {
      setRefreshing(true);
      void refresh().then((next) => {
        setModel(next);
        setRefreshing(false);
      });
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>{">_ kankaku · Catalog"}</Text>
      {model.status === "unavailable" ? (
        <Text>{model.reason ?? "no catalog cached yet"}</Text>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>{`${model.url}  fetched ${formatMinutes(model.ageMs)} ago${model.stale ? "  (stale)" : ""}`}</Text>
          {model.clients.length === 0 ? (
            <Text>no clients</Text>
          ) : (
            model.clients.map((client) => <ClientBlock key={client.id} client={client} />)
          )}
        </Box>
      )}
      <Text dimColor>{`r refresh${refreshing ? " (refreshing…)" : ""}`}</Text>
    </Box>
  );
}
