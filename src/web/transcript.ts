import { MAX_TEXT_POINTS, SpeechError } from '../shared/limits.ts';

interface Item {
  text: string;
  points: number;
  complete: boolean;
  committed: boolean;
  previous: string | null;
}

export class Transcript {
  private readonly items = new Map<string, Item>();
  private points = 0;
  private last: string | null = null;

  private item(id: string): Item {
    if (!id || id.length > 256) throw new SpeechError('PROTOCOL_FAILED', 'Azure 返回了无效的语音段落标识。');
    let item = this.items.get(id);
    if (!item) {
      if (this.items.size >= 4096) throw new SpeechError('PROTOCOL_FAILED', 'Azure 返回的语音段落过多。');
      item = { text: '', points: 0, complete: false, committed: false, previous: null };
      this.items.set(id, item);
    }
    return item;
  }
  commit(id: string, previous?: string | null): void {
    const item = this.item(id);
    if (item.committed) {
      if (previous !== undefined && item.previous !== previous) throw new Error('Conflicting speech order');
      return;
    }
    const predecessor = previous === undefined ? this.last : previous;
    if (predecessor === id || (predecessor !== null && (!predecessor || predecessor.length > 256))) throw new Error('Invalid speech order');
    item.previous = predecessor;
    item.committed = true;
    this.last = id;
  }
  delta(id: string, text: string): void {
    const item = this.item(id);
    if (!item.complete) this.setText(item, item.text + text);
  }
  finish(id: string, text: string): void {
    const item = this.item(id);
    if (item.complete && item.text !== text) throw new Error('Conflicting final transcript');
    this.setText(item, text);
    item.complete = true;
  }
  private setText(item: Item, text: string): void {
    const points = [...text].length;
    const total = this.points - item.points + points;
    if (total > MAX_TEXT_POINTS) throw new SpeechError('PROTOCOL_FAILED', '转写文字超过长度上限。');
    item.text = text; item.points = points; this.points = total;
  }
  private ordered(): Item[] {
    const next = new Map<string | null, { id: string; item: Item }>();
    for (const [id, item] of this.items) {
      if (!item.committed) continue;
      if (next.has(item.previous)) throw new Error('Ambiguous speech order');
      next.set(item.previous, { id, item });
    }
    const ordered: Item[] = [];
    let cursor: string | null = null;
    const visited = new Set<string>();
    while (next.has(cursor)) {
      const entry: { id: string; item: Item } = next.get(cursor)!;
      if (visited.has(entry.id)) throw new Error('Cyclic speech order');
      visited.add(entry.id); ordered.push(entry.item); cursor = entry.id;
    }
    return ordered;
  }
  get text(): string { return this.ordered().map(item => item.text).join(''); }
  get size(): number { return this.items.size; }
  has(id: string): boolean { return this.items.has(id); }
  get complete(): boolean {
    const ordered = this.ordered();
    return ordered.length === this.items.size && ordered.every(item => item.complete);
  }
  seal(): void {
    if (this.ordered().length !== this.items.size) throw new Error('Uncommitted or disconnected speech items');
  }
}
