import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import Workflows from "../src/pages/Workflows";

const keys = ["window", "document", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let saved: PropertyDescriptor[];
let win: Window;
let root: Root;
let host: HTMLElement;
let requests: Array<{ path: string; method: string; body?: string }>;
const definition = { id: "feature-delivery", builtin: true, phases: [{ id: "plan" }, { id: "approve", gate: { id: "plan-approval" } }, { id: "implement" }] };
let task: Record<string, unknown>;
let copiedText: string;
const personal = { id: "daily-opencode", title: "Daily OpenCode", defaults: { worker: "native/worker", planner: "saved/planner" }, phases: [
  { id: "plan", modelRef: "role:planner", mode: "agent", agent: "codex" },
  { id: "implement", modelRef: "role:worker", mode: "agent", agent: "opencode" },
  { id: "verify", modelRef: "role:worker", mode: "agent", agent: "opencode" },
] };

beforeEach(() => {
  saved = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key)!);
  win = new Window({ url: "http://localhost" });
  Object.defineProperty(win.navigator, "language", { value: "en-US" });
  for (const key of keys.slice(0, 5)) Object.defineProperty(globalThis, key, { configurable: true, value: Reflect.get(win, key === "window" ? "window" : key) });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  task = { id: "task-active", title: "Implement login", workflowId: definition.id, definition, status: "awaiting_gate", currentGate: { id: "plan-approval" }, phaseIndex: 1, phases: [{ id: "plan", status: "done", outputs: "Plan evidence" }, { id: "approve", status: "in_progress" }], autoRun: false };
  requests = [];
  copiedText = "";
  Object.defineProperty(win.navigator, "clipboard", { value: { writeText: async (text: string) => { copiedText = text; } } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    const path = String(input);
    requests.push({ path, method: init?.method ?? "GET", body: init?.body as string | undefined });
    if (path.endsWith("/gate")) { task = { ...task, status: "running", phaseIndex: 2, currentGate: undefined }; return Response.json({ task }); }
    if (path.endsWith("/runs/task-active")) return Response.json({ task, journal: [], executing: false });
    if (path.endsWith("/runs")) return Response.json({ runs: [task, { ...task, id: "old", title: "Old smoke test", status: "aborted" }] });
    if (path.endsWith("/workflows")) return init?.method === "POST" ? Response.json({ ok: true }) : Response.json({ definitions: [definition, personal] });
    return Response.json([]);
  } });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await win.happyDOM.close();
  keys.forEach((key, i) => saved[i] ? Object.defineProperty(globalThis, key, saved[i]) : Reflect.deleteProperty(globalThis, key));
});

async function mount() {
  await act(async () => { root.render(<LanguageProvider><Workflows /></LanguageProvider>); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}

test("dashboard monitors active runs without a second task creation form", async () => {
  await mount();
  expect(host.textContent).toContain("Implement login");
  expect(host.textContent).not.toContain("Old smoke test");
  expect(host.querySelector("form")).toBeNull();
  expect(host.querySelector("#workflows-btn-start")).toBeNull();
  expect(host.querySelector(".workflows-template-picker")).not.toBeNull();
  expect(requests.every(r => r.method === "GET")).toBe(true);
  await act(async () => host.querySelector<HTMLInputElement>(".workflows-history-toggle input")!.click());
  expect(host.textContent).toContain("Old smoke test");
});

test("approval updates the run and explains how to resume the conversation", async () => {
  await mount();
  await act(async () => host.querySelector<HTMLButtonElement>(".workflows-run-row")!.click());
  expect(host.textContent).toContain("Plan evidence");
  const approve = host.querySelector<HTMLButtonElement>(".workflows-gate-box .btn-primary")!;
  await act(async () => approve.click());
  const request = requests.find(r => r.path.endsWith("/gate"));
  expect(JSON.parse(request!.body!)).toEqual({ action: "approve" });
  expect(host.textContent).toContain("does not wake that conversation automatically");
  expect(host.querySelector(".workflows-outputs-input")).toBeNull();
  expect(requests.some(r => r.path.endsWith("/execute") || r.path.endsWith("/advance"))).toBe(false);
});

test("selecting a saved template copies its id without launching a run", async () => {
  await mount();
  await act(async () => host.querySelectorAll<HTMLButtonElement>(".workflows-template-option")[1]!.click());
  expect(host.querySelector(".workflows-template-config")?.textContent).toContain("native/worker");
  await act(async () => host.querySelector<HTMLButtonElement>(".workflows-chat-entry button")!.click());
  expect(copiedText).toContain('template "daily-opencode"');
  expect(copiedText).not.toContain("feature-delivery");
  expect(win.localStorage.getItem("ocx-workflow-template:")).toBe("daily-opencode");
  expect(requests.every(r => r.method === "GET")).toBe(true);
});

test("configure a role tool once and preserve the template's models and other roles", async () => {
  await mount();
  await act(async () => host.querySelectorAll<HTMLButtonElement>(".workflows-template-option")[1]!.click());
  await act(async () => host.querySelector<HTMLButtonElement>(".workflows-template-config .btn-secondary")!.click());
  const tool = host.querySelector<HTMLSelectElement>('select[aria-label="Tool for worker"]')!;
  await act(async () => { tool.value = "agy"; tool.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event); });
  await act(async () => host.querySelector<HTMLButtonElement>(".modal-footer .btn-primary")!.click());
  const saved = JSON.parse(requests.find(r => r.path.endsWith("/workflows") && r.method === "POST")!.body!).definition;
  expect(saved.defaults).toEqual(personal.defaults);
  expect(saved.phases[0].agent).toBe("codex");
  expect(saved.phases.slice(1).map((phase: { agent: string }) => phase.agent)).toEqual(["agy", "agy"]);
});
