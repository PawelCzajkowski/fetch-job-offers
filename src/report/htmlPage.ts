import type {
  ReportCounts,
  ReportRow,
  ReportVerdict,
  ReportWorkMode,
} from "./model.ts";

/**
 * The HTML report's in-page code (spec section 10, `VariantB` of the
 * report-layout prototype). Every function here runs twice: in Node under
 * test, and in the browser, where `html.ts` inlines its source through
 * `Function.prototype.toString` (Node strips the types, leaving plain JS).
 *
 * So each function listed in `PAGE_FUNCTIONS` must be self-contained: it may
 * call the others in the list, but nothing else in this module or any import
 * (type imports are fine, they vanish). The DOM is reached only through the
 * narrow `PageEnv` interfaces below, which keeps the project's `lib` free of
 * `dom` and lets tests drive `boot` with a small fake document.
 */

/** What the page embeds as JSON. */
export interface PageData {
  /** Newest first, the default order. */
  rows: ReportRow[];
  /** Search labels in run order, for the picker. */
  searches: string[];
  counts: ReportCounts;
}

/** `"none"` picks rows whose work mode isn't stated. */
export type ModeFilter = "" | NonNullable<ReportWorkMode> | "none";

/** An empty string turns that filter off. */
export interface PageFilter {
  verdict: ReportVerdict | "";
  search: string;
  mode: ModeFilter;
  text: string;
}

export type SortKey =
  | "postedDate"
  | "title"
  | "company"
  | "search"
  | "workMode"
  | "seniority"
  | "salary"
  | "techStack"
  | "verdict";

export interface SortState {
  key: SortKey;
  /** 1 ascending, -1 descending. */
  dir: 1 | -1;
}

export type DescriptionBlock =
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] };

export interface PageText {
  readonly textContent: string | null;
}

export type PageNode = PageElement | PageText;

export interface PageEvent {
  readonly key?: string;
  stopPropagation(): void;
  preventDefault(): void;
}

/** The slice of `HTMLElement` the page uses. No `innerHTML`, on purpose. */
export interface PageElement {
  className: string;
  textContent: string | null;
  value: string;
  setAttribute(name: string, value: string): void;
  append(...nodes: PageNode[]): void;
  replaceChildren(...nodes: PageNode[]): void;
  addEventListener(type: string, listener: (event: PageEvent) => void): void;
  focus(): void;
}

export interface PageDocument {
  createElement(tag: string): PageElement;
  createTextNode(text: string): PageText;
  getElementById(id: string): PageElement | null;
}

/** The browser's side of the page, wired up by the inline bootstrap. */
export interface PageEnv {
  document: PageDocument;
  /** Writes to the clipboard; may reject (or throw) where that's refused. */
  copyText(text: string): Promise<void>;
  /** Lets the user copy by hand when the clipboard refuses. */
  fallbackCopy(text: string): void;
  later(fn: () => void, ms: number): void;
}

export function filterRows(
  rows: readonly ReportRow[],
  filter: PageFilter,
): ReportRow[] {
  const text = filter.text.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (filter.verdict === "" || row.verdict === filter.verdict) &&
      (filter.search === "" ||
        row.foundBy === filter.search ||
        row.alsoFoundBy.includes(filter.search)) &&
      (filter.mode === "" ||
        (filter.mode === "none"
          ? row.workMode === null
          : row.workMode === filter.mode)) &&
      (text === "" ||
        [
          row.title,
          row.company,
          row.techStack.join(", "),
          row.descriptionLines.join("\n"),
        ]
          .join("\n")
          .toLowerCase()
          .includes(text)),
  );
}

/** The value a column sorts by; `null` sorts last either way. */
export function sortValue(
  row: ReportRow,
  key: SortKey,
): string | number | null {
  switch (key) {
    case "search":
      return row.foundBy;
    case "techStack":
      return row.techStack.length === 0 ? null : row.techStack.join(", ");
    case "seniority":
      return row.seniority === null
        ? null
        : ["intern", "junior", "mid", "senior", "lead", "principal"].indexOf(
            row.seniority,
          );
    case "verdict":
      return ["accepted", "unjudged", "rejected"].indexOf(row.verdict);
    default: {
      const value = row[key];
      return value === null || value === "" ? null : value;
    }
  }
}

/** A stable sort, so ties keep the input's (newest-first) order. */
export function sortRows(
  rows: readonly ReportRow[],
  sort: SortState,
): ReportRow[] {
  return [...rows].sort((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    if (x === null || y === null) {
      return x === y ? 0 : x === null ? 1 : -1;
    }
    const order =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y), undefined, {
            sensitivity: "base",
            numeric: true,
          });
    return sort.dir * order;
  });
}

/**
 * Lines starting with `- ` become list items (consecutive ones share a
 * list); other lines become paragraphs; an empty line ends a list.
 */
export function descriptionBlocks(
  lines: readonly string[],
): DescriptionBlock[] {
  const blocks: DescriptionBlock[] = [];
  let list: string[] | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      list = null;
    } else if (line.startsWith("- ")) {
      if (list === null) {
        list = [];
        blocks.push({ kind: "ul", items: list });
      }
      list.push(line.slice(2).trim());
    } else {
      list = null;
      blocks.push({ kind: "p", text: line });
    }
  }
  return blocks;
}

/** Only these go into an `href`. */
export function isLinkedInUrl(url: string): boolean {
  return url.startsWith("https://www.linkedin.com/");
}

/** Builds the toolbar and table into `#app` and keeps them in sync. */
export function boot(env: PageEnv, data: PageData): void {
  const doc = env.document;
  const root = doc.getElementById("app");
  if (root === null) return;

  type Kid = PageNode | string | null;
  // Every string becomes a text node; nothing is ever parsed as markup.
  const el = (
    tag: string,
    attrs: Record<string, string>,
    ...kids: Kid[]
  ): PageElement => {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (name === "class") node.className = value;
      else node.setAttribute(name, value);
    }
    for (const kid of kids) {
      if (kid === null) continue;
      node.append(typeof kid === "string" ? doc.createTextNode(kid) : kid);
    }
    return node;
  };
  // Click, or Enter / Space when focused.
  const onActivate = (node: PageElement, action: () => void) => {
    node.addEventListener("click", action);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        action();
      }
    });
  };
  const dash = (value: string | null) =>
    value === null || value === "" ? "–" : value;
  const badge = (verdict: ReportVerdict) =>
    el("span", { class: `badge ${verdict}` }, verdict);

  const filter: PageFilter = {
    verdict: "accepted",
    search: "",
    mode: "",
    text: "",
  };
  let sort: SortState = { key: "postedDate", dir: -1 };
  const expanded = new Set<string>();
  const columns: Array<[SortKey, string]> = [
    ["postedDate", "Posted"],
    ["title", "Title"],
    ["company", "Company"],
    ["search", "Search"],
    ["workMode", "Mode"],
    ["seniority", "Seniority"],
    ["salary", "Salary"],
    ["techStack", "Stack"],
    ["verdict", "Verdict"],
  ];
  let rowElements = new Map<string, PageElement>();

  const verdictButtons = (
    [
      ["", "All", data.counts.rows],
      ["accepted", "Accepted", data.counts.accepted],
      ["rejected", "Rejected", data.counts.rejected],
      ["unjudged", "Unjudged", data.counts.unjudged],
    ] as Array<[PageFilter["verdict"], string, number]>
  ).map(([value, label, count]) => {
    const button = el("button", { type: "button" }, `${label} ${count}`);
    button.addEventListener("click", () => {
      filter.verdict = value;
      draw();
    });
    return { value, button };
  });

  const searchPicker = el(
    "select",
    { "aria-label": "Saved search" },
    el("option", { value: "" }, "All searches"),
    ...data.searches.map((label) => el("option", { value: label }, label)),
  );
  searchPicker.addEventListener("change", () => {
    filter.search = searchPicker.value;
    draw();
  });

  const modePicker = el(
    "select",
    { "aria-label": "Work mode" },
    ...[
      ["", "Any work mode"],
      ["remote", "remote"],
      ["hybrid", "hybrid"],
      ["on-site", "on-site"],
      ["none", "not stated"],
    ].map(([value = "", label = ""]) => el("option", { value }, label)),
  );
  modePicker.addEventListener("change", () => {
    filter.mode = modePicker.value as ModeFilter;
    draw();
  });

  const textFilter = el("input", {
    type: "search",
    placeholder: "Filter by title, company, stack, description…",
    "aria-label": "Filter text",
  });
  textFilter.addEventListener("input", () => {
    filter.text = textFilter.value;
    draw();
  });

  const headers = columns.map(([key, label]) => {
    const th = el("th", { scope: "col", tabindex: "0" });
    onActivate(th, () => {
      sort = { key, dir: sort.key === key && sort.dir === 1 ? -1 : 1 };
      draw();
    });
    return { key, label, th };
  });

  const status = el("div", { class: "status muted" });
  const tbody = el("tbody", {});

  const toggle = (rowId: string) => {
    if (expanded.has(rowId)) expanded.delete(rowId);
    else expanded.add(rowId);
    draw();
    rowElements.get(rowId)?.focus();
  };

  const renderDetail = (row: ReportRow): PageElement => {
    const facts = [row.employmentType, row.jobFunction, row.industries].filter(
      (fact): fact is string => fact !== null && fact !== "",
    );
    const description = row.descriptionLines.join("\n");
    const copyButton = el(
      "button",
      { type: "button", class: "btn" },
      "Copy description",
    );
    copyButton.addEventListener("click", (event) => {
      event.stopPropagation();
      let copied: Promise<void>;
      try {
        copied = env.copyText(description);
      } catch (error) {
        copied = Promise.reject(error);
      }
      copied.then(
        () => {
          copyButton.textContent = "Copied";
          env.later(() => {
            copyButton.textContent = "Copy description";
          }, 1500);
        },
        () => env.fallbackCopy(description),
      );
    });
    const link = isLinkedInUrl(row.url)
      ? el(
          "a",
          {
            class: "btn primary",
            href: row.url,
            target: "_blank",
            rel: "noopener noreferrer",
          },
          "Open on LinkedIn",
        )
      : null;
    const blocks = descriptionBlocks(row.descriptionLines);
    const desc = el(
      "div",
      { class: "desc" },
      ...blocks.map((block) =>
        block.kind === "p"
          ? el("p", {}, block.text)
          : el("ul", {}, ...block.items.map((item) => el("li", {}, item))),
      ),
    );
    if (blocks.length === 0) {
      desc.append(el("p", { class: "muted" }, "No description."));
    }
    return el(
      "tr",
      { class: "detail" },
      el(
        "td",
        { colspan: String(columns.length) },
        el(
          "div",
          { class: "detail-grid" },
          el(
            "div",
            {},
            el("p", { class: "reason" }, badge(row.verdict), " ", row.reason),
            el("div", { class: "muted" }, row.location),
            facts.length === 0
              ? null
              : el(
                  "div",
                  { class: "chips" },
                  ...facts.map((fact) => el("span", { class: "chip" }, fact)),
                ),
            row.alsoFoundBy.length === 0
              ? null
              : el(
                  "div",
                  { class: "muted" },
                  `Also found by: ${row.alsoFoundBy.join(", ")}`,
                ),
            el("div", { class: "actions" }, link, copyButton),
          ),
          desc,
        ),
      ),
    );
  };

  const renderRow = (row: ReportRow): PageElement[] => {
    const open = expanded.has(row.rowId);
    const stack = row.techStack.join(", ");
    const tr = el(
      "tr",
      { class: "row", tabindex: "0", "aria-expanded": String(open) },
      el("td", { class: "muted nowrap" }, row.postedDate),
      el("td", {}, el("b", {}, row.title)),
      el("td", {}, row.company),
      el("td", { class: "muted nowrap" }, row.foundBy),
      el("td", { class: "nowrap" }, dash(row.workMode)),
      el("td", {}, dash(row.seniority)),
      el("td", {}, dash(row.salary)),
      el("td", {}, el("div", { class: "stack", title: stack }, dash(stack))),
      el("td", {}, badge(row.verdict)),
    );
    onActivate(tr, () => toggle(row.rowId));
    rowElements.set(row.rowId, tr);
    return open ? [tr, renderDetail(row)] : [tr];
  };

  const draw = () => {
    for (const { value, button } of verdictButtons) {
      const on = value === filter.verdict;
      button.className = on ? "on" : "";
      button.setAttribute("aria-pressed", String(on));
    }
    for (const { key, label, th } of headers) {
      const active = key === sort.key;
      const arrow = sort.dir === 1 ? " ▲" : " ▼";
      th.textContent = active ? label + arrow : label;
      const direction = sort.dir === 1 ? "ascending" : "descending";
      th.setAttribute("aria-sort", active ? direction : "none");
    }
    const rows = sortRows(filterRows(data.rows, filter), sort);
    status.textContent = `Showing ${rows.length} of ${data.rows.length} · click a row to expand · click a header to sort`;
    rowElements = new Map();
    tbody.replaceChildren(
      ...(rows.length === 0
        ? [
            el(
              "tr",
              { class: "empty" },
              el(
                "td",
                { colspan: String(columns.length), class: "muted" },
                "No offers match these filters.",
              ),
            ),
          ]
        : rows.flatMap(renderRow)),
    );
  };

  root.replaceChildren(
    el(
      "div",
      { class: "tools" },
      el(
        "div",
        { class: "seg", role: "group", "aria-label": "Verdict" },
        ...verdictButtons.map(({ button }) => button),
      ),
      searchPicker,
      modePicker,
      textFilter,
    ),
    status,
    el(
      "div",
      { class: "scroll" },
      el(
        "table",
        {},
        el("thead", {}, el("tr", {}, ...headers.map(({ th }) => th))),
        tbody,
      ),
    ),
  );
  draw();
}

/** Everything `html.ts` inlines, in order; `boot` comes last. */
export const PAGE_FUNCTIONS: ReadonlyArray<(...args: never[]) => unknown> = [
  filterRows,
  sortValue,
  sortRows,
  descriptionBlocks,
  isLinkedInUrl,
  boot,
];
