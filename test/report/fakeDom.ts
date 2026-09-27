/**
 * A tiny stand-in for the browser DOM, just enough for the report page's
 * script (no jsdom). It can't parse markup: setting `innerHTML` or
 * `outerHTML` throws, so a test passing through it proves all text went in
 * as text nodes.
 */

export class FakeText {
  readonly nodeType = 3;
  data: string;
  constructor(data: string) {
    this.data = data;
  }
  get textContent(): string {
    return this.data;
  }
}

type Child = FakeElement | FakeText;
type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
  key?: string;
  stopPropagation(): void;
  preventDefault(): void;
}

export class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  children: Child[] = [];
  attributes = new Map<string, string>();
  className = "";
  value = "";
  listeners = new Map<string, Listener[]>();
  focused = false;

  constructor(tag: string) {
    this.tagName = tag.toLowerCase();
  }

  get id(): string {
    return this.attributes.get("id") ?? "";
  }

  get textContent(): string {
    return this.children.map((child) => child.textContent).join("");
  }

  set textContent(text: string) {
    this.children = text === "" ? [] : [new FakeText(text)];
  }

  set innerHTML(_: string) {
    throw new Error("innerHTML must not be used");
  }

  set outerHTML(_: string) {
    throw new Error("outerHTML must not be used");
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...nodes: Child[]): void {
    for (const node of nodes) {
      if (!(node instanceof FakeElement || node instanceof FakeText)) {
        throw new Error(`append() got a non-node: ${String(node)}`);
      }
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: Child[]): void {
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  focus(): void {
    this.focused = true;
  }

  /** Fires the listeners for `type`; returns whether propagation stopped. */
  fire(type: string, init: { key?: string } = {}): boolean {
    let stopped = false;
    const event: FakeEvent = {
      ...init,
      stopPropagation: () => {
        stopped = true;
      },
      preventDefault: () => {},
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return stopped;
  }

  /** Every descendant element, depth first. */
  all(): FakeElement[] {
    return this.children.flatMap((child) =>
      child instanceof FakeElement ? [child, ...child.all()] : [],
    );
  }

  find(predicate: (el: FakeElement) => boolean): FakeElement[] {
    return this.all().filter(predicate);
  }

  byTag(tag: string): FakeElement[] {
    return this.find((el) => el.tagName === tag);
  }

  byClass(name: string): FakeElement[] {
    return this.find((el) => el.className.split(" ").includes(name));
  }
}

export class FakeDocument {
  readonly body = new FakeElement("body");

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(String(text));
  }

  getElementById(id: string): FakeElement | null {
    return this.body.find((el) => el.id === id)[0] ?? null;
  }

  /** Adds an element with this id (and optional text) to the body. */
  add(tag: string, id: string, text = ""): FakeElement {
    const el = this.createElement(tag);
    el.setAttribute("id", id);
    el.textContent = text;
    this.body.append(el);
    return el;
  }
}
