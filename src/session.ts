import { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { retry } from "./utils";
import { ChildProcess } from 'child_process';
import { DriverConfiguration, SessionDto } from "./types";
import { Request } from 'koa';
import _ from 'lodash';
import { ProcessManager } from "./process";
import { SF_CAPS_FIELDS } from "./constants";
import * as fs from 'fs';


export class RequestCapabilities {

  get data() { return this.request.body as any; }
  get href() { return this.request.href.replace(/\/$/, ""); }

  constructor(private request: Request) { }

  getSessionBaseUrl(isWebsocket: boolean) {
    let proto = this.request.protocol;
    if (isWebsocket) {
      proto = {
        'http': 'ws',
        'https': 'wss',
      }[proto] || 'ws';
    }
    return `${proto}://${this.request.host}${this.request.path}`;
  }

  get browserName() { return this.getValue('browserName'); }
  get browserVersion() { return this.getValue('browserVersion'); }
  get browserUUID() { return this.getValue(SF_CAPS_FIELDS.BROWSER_UUID); }
  get browserTags(): string[] | undefined { return this.getValue(SF_CAPS_FIELDS.BROWSER_TAGS) as any };

  get platformName() { return this.getValue('platformName'); }

  get nodeUUID() { return this.getValue(SF_CAPS_FIELDS.NODE_UUID); }
  get nodeTags(): string[] | undefined { return this.getValue(SF_CAPS_FIELDS.NODE_TAGS) as any };

  get environmentVariables(): any { return this.getValue(SF_CAPS_FIELDS.ENVS) || {}; }

  get shouldcleanUserData(): boolean | undefined {
    const cleanUserData = this.getValue(SF_CAPS_FIELDS.CLEAN_USER_DATA);
    if ('boolean' == typeof cleanUserData) {
      return cleanUserData;
    }
  }

  private getValue(key: string): unknown {
    const caps = this.data.capabilities?.alwaysMatch || this.data.desiredCapabilities || {};
    return caps[key];
  }

  get sanitizedCapbilities() {
    const caps = _.cloneDeep(this.data);
    for (const key of ['browserVersion', 'extOptions', 'tags', ...Object.values(SF_CAPS_FIELDS)]) {
      if (caps.desiredCapabilities) {
        delete caps.desiredCapabilities[key];
      }
      if (caps.capabilities?.alwaysMatch) {
        delete caps.capabilities.alwaysMatch[key];
      }
    }
    return caps;
  }
}

export class ResponseCapabilities {

  private rawResponseData: any

  constructor(private rawResponse: any, private request: RequestCapabilities) {
    this.rawResponseData = rawResponse?.value || rawResponse; //  w3c format || json wired format
  }

  get sessionId() {
    return this.rawResponseData?.sessionId;
  }

  get sessionBaseUrl() {
    return `${this.request}`
  }

  get browserVersion() {
    return this.rawResponseData?.capabilities?.browserVersion;
  }

  get cdpEndpoint() {
    return `${this.request.getSessionBaseUrl(true)}/${this.sessionId}/se/cdp`;
  }

  get chromeDebuggerAddress() {
    return this.rawResponseData?.capabilities?.["goog:chromeOptions"]?.debuggerAddress;
  }

  get chromeUserDataDir() {
    return this.rawResponseData?.capabilities?.chrome?.userDataDir;
  }

  get msEdgeDebuggerAddress() {
    return this.rawResponseData?.capabilities?.["ms:edgeOptions"]?.debuggerAddress;
  }

  get msEdgeUserDataDir() {
    return this.rawResponseData?.capabilities?.msedge?.userDataDir;
  }

  get firefoxProfilePath() {
    return this.rawResponseData?.capabilities?.['moz:profile'];
  }

  get jsonObject() {
    const raw = _.cloneDeep(this.rawResponse);
    // patch capabilities
    const newResponseData = raw.value || raw;
    // set cdp endpoint
    if (this.chromeDebuggerAddress || this.msEdgeDebuggerAddress) {
      newResponseData.capabilities['se:cdp'] = this.cdpEndpoint;
      newResponseData.capabilities['se:cdpVersion'] = 'FIXME';  // FIXME
    }
    return raw;
  }
}

export interface ISession {
  id: string;
  getCdpEndpoint: () => Promise<string | void>;
  start: () => Promise<ResponseCapabilities>;
  stop: () => Promise<void>;
  forward: (request: AxiosRequestConfig) => Promise<AxiosResponse<any>>;
  jsonObject: SessionDto;
}

export function createSession(
  request: RequestCapabilities,
  webdriverConfiguration: DriverConfiguration,
  processManager: ProcessManager,
  axios: AxiosInstance,
) {
  switch (request.browserName) {
    case 'chrome': return new ChromiumSession(request, webdriverConfiguration, processManager, axios);
    case 'MicrosoftEdge': return new ChromiumSession(request, webdriverConfiguration, processManager, axios);
    case 'firefox': return new FirefoxSession(request, webdriverConfiguration, processManager, axios);
    case 'safari': return new CommonWebdriverSession(request, webdriverConfiguration, processManager, axios);
    default: throw Error(`browser ${request.browserName} is not supported`);
  }
}

abstract class AbstractWebdriveSession implements ISession {

  public response?: ResponseCapabilities;
  protected process?: ChildProcess;
  protected port?: number;

  constructor(
    public request: RequestCapabilities,
    protected webdriverConfiguration: DriverConfiguration,
    protected processManager: ProcessManager,
    protected axios: AxiosInstance,
  ) { }

  get id(): string {
    const sessionId = this.response?.sessionId;
    if (!sessionId || 'string' != typeof sessionId) {
      throw new Error(`sessionId is invalid: ${sessionId}`);
    }
    return sessionId;
  }

  get jsonObject() {
    return {
      id: this.id,
      responseCapabilities: this.response?.jsonObject,
    };
  }

  async start() {
    const { port, webdriverProcess } = await this.processManager.spawnWebdriverProcess({
      path: this.webdriverConfiguration.webdriver.path,
      envs: { ...this.webdriverConfiguration.webdriver.envs, ...this.request.environmentVariables },
      args: this.webdriverConfiguration.webdriver.args,
    });
    this.port = port;
    this.process = webdriverProcess;
    this.axios.defaults.baseURL = `http://localhost:${this.port}`;
    await this.waitForReady();
    const res = await this.createSession(this.request);
    this.response = res;
    return res;
  }

  async stop() {
    await this.axios.delete(`/session/${this.id}`);
    this.killProcessGroup();
    await this.postStop();
  }

  async forward(request: AxiosRequestConfig) {
    return await this.axios.request(request);
  }

  get shouldCleanUserData(): boolean {
    const cleanUserData = this.request?.shouldcleanUserData;
    return _.isNil(cleanUserData) ? this.webdriverConfiguration.cleanUserData : cleanUserData;
  }

  async getCdpEndpoint(): Promise<string | undefined> { return; }

  async postStop() { }

  get userDataDir(): string | undefined { return undefined; }

  private async waitForReady() {
    await retry(async () => await this.axios.get('/status'), { max: 10, interval: 1e2 });
  }

  private async createSession(request: RequestCapabilities) {
    const res = await this.axios.post('/session', this.mergeDefaultCaps(request.sanitizedCapbilities));
    console.log(`create session:`);
    console.log(res.data);
    return new ResponseCapabilities(res.data, request);
  }

  private mergeDefaultCaps(caps: any) {
    const defaultCaps = this.webdriverConfiguration.defaultCapabilities;
    if (caps.desiredCapabilities) {
      _.merge(caps.desiredCapabilities, defaultCaps);
    }
    if (caps.capabilities?.alwaysMatch) {
      _.merge(caps.capabilities.alwaysMatch, defaultCaps);
    }
    return caps;
  }

  private killProcessGroup() {
    if (this.process) {
      try {
        this.processManager.killProcessGroup(this.process)
      } catch (e) {
        console.warn(`ingore error during kill process`, e);
      }
    }
  }
}

class CommonWebdriverSession extends AbstractWebdriveSession { }

class ChromiumSession extends CommonWebdriverSession {

  async getCdpEndpoint() {
    const debuggerAddress = this.response?.chromeDebuggerAddress || this.response?.msEdgeDebuggerAddress;
    if (!debuggerAddress) return;
    const res = await this.axios.request({
      baseURL: 'http://' + debuggerAddress,
      url: '/json/version',
      method: 'GET',
    });
    return res.data?.webSocketDebuggerUrl as string;
  }

  async postStop() {
    const userDataDir = this.response?.chromeUserDataDir || this.response?.msEdgeUserDataDir;
    if (this.shouldCleanUserData && userDataDir) {
      try {
        console.log(`clean user data: ${userDataDir}`);
        await fs.promises.rm(userDataDir, { recursive: true, force: true });
      } catch (e) {
        console.warn(`ignore error during rm ${userDataDir}`, e);
      }
    }
  }
}

class FirefoxSession extends CommonWebdriverSession {
  get userDataDir() {
    return this.response?.firefoxProfilePath;
  }
}