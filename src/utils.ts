import axios from "axios";
import Bluebird from "bluebird";
import * as fs from 'fs';
import * as stream from 'stream';

interface IRetryOption {
  max?: number;
  interval?: number;
  condition?: (e: any) => boolean;
}

export async function retry<T>(cb: () => Promise<T> | T, option: IRetryOption = {}): Promise<T | undefined> {
  const max = option.max || 10;
  const interval = option.interval || 1e3;
  for (let i = 0; i < max; i++) {
    try {
      return await cb();
    } catch (e) {
      if ((!option.condition || option.condition(e)) && i < max - 1) {
        console.warn(`[warning] ${String(e)} retry...`);
        await Bluebird.delay(interval);
        continue;
      }
      throw e;
    }
  }
}

class CacheNode<K, V> {
  constructor(
    public readonly key?: K,
    public value?: V,
    public prev?: CacheNode<K, V>,
    public next?: CacheNode<K, V>,
  ) { }
}

export class LruCache<K, V> {

  private map = new Map<K, CacheNode<K, V>>();
  private head = new CacheNode<K, V>(undefined, undefined);

  constructor(
    private maxSize: number,
  ) { }

  set(key: K, value: V) {
    if (this.map.size >= this.maxSize) {
      const tail = this.getTailNode();
      if (tail) {
        this.map.delete(tail.key!);
        this.removeNode(tail);
      }
    }
    let node = this.map.get(key);
    if (node) {
      this.removeNode(node);
      node.value = value;
    } else {
      node = new CacheNode<K, V>(key, value)
    }
    this.map.set(key, node);
    this.insertNode(node, this.head);
  }

  get(key: K) {
    const node = this.map.get(key)
    if (!node) return;

    this.removeNode(node);
    this.insertNode(node, this.head);
    return node.value;
  }

  private insertNode(node: CacheNode<K, V>, after: CacheNode<K, V>) {
    node.prev = after;
    node.next = after.next;
    after.next = node;
  }

  private removeNode(node: CacheNode<K, V>) {
    node.prev!.next = node.next;
    if (node.next) {
      node.next.prev = node.prev;
    }
  }

  private getTailNode() {
    if (!this.head.next) return
    let node = this.head;
    while (node.next) {
      node = node.next;
    }
    return node;
  }
}

export class KeywordMutex<K> {
  private map = new Map<K, Semaphore>();

  constructor() { }

  async lock(key: K) {
    let sempahore = this.map.get(key);
    if (!sempahore) {
      sempahore = new Semaphore(1);
      this.map.set(key, sempahore);
    }
    await sempahore.wait();
  }

  release(key: K) {
    const sempahore = this.map.get(key);
    if (!sempahore) {
      throw Error(`key: ${key} has not been locked`)
    }
    sempahore.signal();
    if (1 === sempahore.size) {
      this.map.delete(key);  // remove keyword when lock is free, or else will have memory leak
    }
  }

  getPending(key: K) {
    const sempahore = this.map.get(key);
    return sempahore ? (1 - sempahore.size) : 0;
  }
}

export class Semaphore {
  queue: ((value?: any) => void)[] = [];

  constructor(public size: number) { }

  async wait() {
    if (this.size - 1 < 0) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.size -= 1;
  }

  signal() {
    this.size += 1;
    const resolve = this.queue.shift();
    if (resolve) resolve();
  }
}

export class Watchdog {

  private timestamp: number = 0;
  private timer: NodeJS.Timeout;

  constructor(private onTimeout: () => any, private timeout: number = 60, interval: number = 5e3) {
    this.feed();
    this.timer = setInterval(() => {
      if (this.timestamp < Date.now()) {
        console.log('Watchdog timeout!');
        this.stop();
        this.onTimeout();
      }
    }, interval);
  }

  feed() {
    this.timestamp = Date.now() + this.timeout * 1e3;
  }

  stop() {
    clearInterval(this.timer);
  }
}

export function getW3CPlatformName() {
  switch (process.platform) {
    case "win32": return "windows";
    case "darwin": return "mac";
    default: return "linux";
  }
}

export function getDefaultRebootCommand() {
  switch (process.platform) {
    case "win32": return `shutdown /r`;
    case "darwin": return `osascript -e 'tell app "System Events" to restart'`;
    default: return `sudo reboot`;
  }
}

export function logMessage(s: string) {
  console.log(s);
}

export function logException(e: Error) {
  console.error(e);
}

export const alwaysTrue = () => true;
export const identity = (i: any) => i;

export async function readPathOrUrl(pathOrUrl: string, options?: any) {
  if (isHttpUrl(pathOrUrl)) {
    const res = await axios.get(pathOrUrl, {
      transformRequest: identity,
      transformResponse: identity,
    });
    return res.data;
  } else {
    return await fs.promises.readFile(pathOrUrl, options);
  }
}

export function isHttpUrl(pathOrUrl: string) {
  return /^https?:\/\//.test(pathOrUrl)
}

export async function saveUrlToFile(url: string, path: string) {
  const writer = fs.createWriteStream(path);
  await axios.request({
    method: 'GET',
    url,
    responseType: 'stream',
  }).then(res => {
    res.data.pipe(writer);
    return stream.promises.finished(writer);
  })
}