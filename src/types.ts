import * as yup from 'yup';
import * as os from 'os';
import { getW3CPlatformName } from './utils';
import { v4 as uuidv4 } from 'uuid';
import type { Context } from 'koa';

const BROWSER_NAMES = ['chrome', 'firefox', 'safari', 'MicrosoftEdge'];
const ROLES = ['hub', 'node'];

export const sessionDtoSchema = yup.object({
  id: yup.string().defined(),
  responseCapabilities: yup.object().optional(),
}).defined();

export const driverConfigurationSchema = yup.object({
  browserName: yup.string().oneOf(BROWSER_NAMES).defined(),
  browserVersion: yup.string().defined(),
  browserIdleTimeout: yup.number(),
  platformName: yup.string().default(getW3CPlatformName()),
  uuid: yup.string().default(() => uuidv4()),
  tags: yup.array(yup.string().defined()).default([]),
  webdriver: yup.object({
    path: yup.string().defined(),
    args: yup.array(yup.string().defined()).default([]),
    envs: yup.object().default({}),
  }).defined(),
  maxSessions: yup.number().default(1),
  defaultCapabilities: yup.object().default({}),
  cleanUserData: yup.boolean().default(true),
  sessions: yup.array(sessionDtoSchema).default([]),
}).defined();

export const remoteDriverConfigurationSchema = yup.object({
  url: yup.string().defined(),
  registerAt: yup.number().defined(),
}).defined();

export const configurationSchema = yup.object({
  role: yup.string().oneOf(ROLES).defined(),
  port: yup.number().default(4444),
  host: yup.string().default('0.0.0.0'),
  tags: yup.array(yup.string().defined()).default([]),

  uuid: yup.string().default(() => uuidv4()),
  platformName: yup.string().default(getW3CPlatformName()),

  browserIdleTimeout: yup.number().default(60),
  maxSessions: yup.number().default(Math.max(1, os.cpus().length - 1)),

  registerTimeout: yup.number().default(60),
  registerTo: yup.string().optional(),
  registerAs: yup.string().optional(),

  sentryDSN: yup.string().optional(),
  sentryDebug: yup.boolean().default(false),

  autoCmdHttp: yup.object({
    disable: yup.boolean().default(false),
    path: yup.string().defined(),
    args: yup.array(yup.string().defined()).default([]),
    maxSessions: yup.number().default(5),
  }).default(undefined),

  configFilePath: yup.string().defined(),
  drivers: yup.array(driverConfigurationSchema).default([]),
}).defined();

export interface Configuration extends yup.Asserts<typeof configurationSchema> { };
export interface DriverConfiguration extends yup.Asserts<typeof driverConfigurationSchema> { };
export interface RemoteDriverConfiguration extends yup.Asserts<typeof remoteDriverConfigurationSchema> { };
export interface SessionDto extends yup.Asserts<typeof sessionDtoSchema> { };
export type Driver = DriverConfiguration | RemoteDriverConfiguration;

export interface DriverMatchCriteria {
  browserName?: string;
  platformName?: string;
  browserVersion?: string;
  uuid?: string;
  tags: string[];
}

export interface SessionPathParams {
  sessionId: string,
  suffix?: string,
}


export interface WebdriverError<T = unknown> {
  code: number;
  error: string;
  message: string;
  stacktrace: string;
  data?: T;
}

export interface AutoCmdError<T = unknown> extends WebdriverError<T> { }

export type RequestHandler = (ctx: Context, next: () => Promise<any>) => Promise<void> | void;
