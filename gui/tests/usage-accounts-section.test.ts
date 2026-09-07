import { expect, test } from "bun:test";

const LOCALES = ["en", "de", "fr", "ja", "ko", "ru", "tr", "zh", "zh-TW"] as const;

async function read(relPath: string): Promise<string> {
  return Bun.file(new URL(relPath, import.meta.url)).text();
}

test("Usage page defines and mounts UsageAccountsTable in section order", async () => {
  const page = await read("../src/pages/Usage.tsx");

  // Contract definitions
  expect(page).toContain("interface UsageAccount");
  expect(page).toContain("accounts?: UsageAccount[];");
  expect(page).toContain("function UsageAccountsTable(");
  expect(page).toContain("usage-accounts-title");
  expect(page).toContain("id: \"accounts\"");

  // Mounting order: SummaryCards -> Heatmap -> Models -> Providers -> Accounts -> Coverage
  const order = [
    "<UsageSummaryCards",
    "<UsageHeatmapPanel",
    "<UsageModelsTable",
    "<UsageProvidersTable",
    "<UsageAccountsTable",
    "<UsageCoveragePanel",
  ];

  let cursor = -1;
  for (const marker of order) {
    const at = page.indexOf(marker);
    expect(at).toBeGreaterThan(cursor);
    cursor = at;
  }
});

test("Usage page includes account mapping and search states", async () => {
  const page = await read("../src/pages/Usage.tsx");

  expect(page).toContain("const [accountQuery, setAccountQuery] = useState");
  expect(page).toContain("const [accountMap, setAccountMap] = useState");
  expect(page).toContain("/api/codex-auth/accounts");
  expect(page).toContain("onAccountQuery");
  expect(page).toContain("accountMap");
});

test("every locale carries all usage account keys", async () => {
  const requiredKeys = [
    "\"usage.section.accounts\":",
    "\"usage.search.accounts\":",
    "\"usage.col.account\":",
    "\"usage.account.filteredNotice\":",
    "\"usage.account.ambiguous\":",
  ];

  for (const locale of LOCALES) {
    const dict = await read(`../src/i18n/${locale}.ts`);
    for (const key of requiredKeys) {
      expect(dict).toContain(key);
    }
  }
});
