/**
 * Interactive prompting, injected so `kankaku setup` can be driven by a
 * real terminal (`adapters/setup/readline-prompter.ts`) or a scripted fake
 * in tests. `--yes` bypasses every prompt by answering each question with
 * its own default instead of calling this at all.
 */
export interface Prompter {
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  text(question: string, defaultValue: string): Promise<string>;
  /** Never echoes the typed input back. */
  secret(question: string): Promise<string>;
}
