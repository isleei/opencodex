import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { navigateHash, normalizeHashPath } from "../hash-routing";
import { useT, type TKey } from "../i18n/shared";
import { IconSparkles, IconServer } from "../icons";
import SkillsTab from "./skills-mcp/SkillsTab";
import McpTab from "./skills-mcp/McpTab";

type SkillsMcpSubTab = "skills" | "mcp";

interface TabDefinition {
  id: SkillsMcpSubTab;
  hash: string;
  labelKey: TKey;
  Icon: typeof IconSparkles;
}

const SUB_TABS: readonly TabDefinition[] = [
  { id: "skills", hash: "skills/skills", labelKey: "skillsMcp.tab.skills", Icon: IconSparkles },
  { id: "mcp", hash: "skills/mcp", labelKey: "skillsMcp.tab.mcp", Icon: IconServer },
] as const;

function readSubTab(hash = typeof window !== "undefined" ? window.location.hash : ""): SkillsMcpSubTab {
  const raw = normalizeHashPath(hash);
  if (raw === "skills/mcp") return "mcp";
  return "skills";
}

function tabDomId(tabId: SkillsMcpSubTab): string {
  return `skills-mcp-tab-${tabId}`;
}

function panelDomId(tabId: SkillsMcpSubTab): string {
  return `skills-mcp-panel-${tabId}`;
}

export default function SkillsMcp({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [activeTab, setActiveTab] = useState<SkillsMcpSubTab>(readSubTab);
  const [mounted, setMounted] = useState<ReadonlySet<SkillsMcpSubTab>>(
    () => new Set([readSubTab()])
  );
  const tabRefs = useRef<Map<SkillsMcpSubTab, HTMLButtonElement> | null>(null);
  if (tabRefs.current === null) tabRefs.current = new Map();

  const activateTab = (next: SkillsMcpSubTab) => {
    setActiveTab(next);
    setMounted(current => (current.has(next) ? current : new Set([...current, next])));
  };

  useEffect(() => {
    const syncFromHash = () => activateTab(readSubTab());
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("popstate", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      window.removeEventListener("popstate", syncFromHash);
    };
  }, []);

  const selectTab = (next: SkillsMcpSubTab, moveFocus: boolean) => {
    const def = SUB_TABS.find(candidate => candidate.id === next);
    if (!def) return;
    navigateHash(def.hash);
    activateTab(next);
    if (moveFocus) {
      window.requestAnimationFrame(() => {
        tabRefs.current?.get(next)?.focus({ preventScroll: true });
      });
    }
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = SUB_TABS.findIndex(candidate => candidate.id === activeTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + SUB_TABS.length) % SUB_TABS.length;
    else if (event.key === "ArrowRight") nextIndex = (index + 1) % SUB_TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = SUB_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    selectTab(SUB_TABS[nextIndex].id, true);
  };

  return (
    <section className="skills-mcp-page">
      <div className="page-head">
        <h2>{t("nav.skills")}</h2>
      </div>
      <p className="page-sub">{t("skillsMcp.subtitle")}</p>

      <div className="page-tabs" role="tablist" aria-label={t("skillsMcp.tabsLabel")}>
        {SUB_TABS.map(def => {
          const isSelected = activeTab === def.id;
          const { Icon } = def;
          return (
            <button
              key={def.id}
              ref={node => {
                if (node) tabRefs.current!.set(def.id, node);
                else tabRefs.current!.delete(def.id);
              }}
              type="button"
              role="tab"
              id={tabDomId(def.id)}
              aria-selected={isSelected}
              aria-controls={panelDomId(def.id)}
              tabIndex={isSelected ? 0 : -1}
              className={`page-tab${isSelected ? " page-tab--active" : ""}`}
              onClick={() => selectTab(def.id, true)}
              onKeyDown={handleTabKeyDown}
            >
              <Icon /> {t(def.labelKey)}
            </button>
          );
        })}
      </div>

      <div className="page-panel-container">
        {mounted.has("skills") && (
          <div
            id={panelDomId("skills")}
            role="tabpanel"
            aria-labelledby={tabDomId("skills")}
            hidden={activeTab !== "skills"}
            className="skills-mcp-panel"
          >
            <SkillsTab apiBase={apiBase} active={activeTab === "skills"} />
          </div>
        )}

        {mounted.has("mcp") && (
          <div
            id={panelDomId("mcp")}
            role="tabpanel"
            aria-labelledby={tabDomId("mcp")}
            hidden={activeTab !== "mcp"}
            className="skills-mcp-panel"
          >
            <McpTab apiBase={apiBase} active={activeTab === "mcp"} />
          </div>
        )}
      </div>
    </section>
  );
}
