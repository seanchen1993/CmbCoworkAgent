/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import path from 'path';

import {
  DuckDBInstance,
  LIST,
  STRUCT,
  VARCHAR,
  listValue,
  structValue,
  timestampValue,
} from '@duckdb/node-api';

import { stripAnsi } from './utils';

import type { FullConfig, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import type { DuckDBAppender } from '@duckdb/node-api';

const ANNOTATIONS_TYPE = LIST(STRUCT({ type: VARCHAR, description: VARCHAR }));
const TAGS_TYPE = LIST(VARCHAR);

class ParquetReporter implements Reporter {
  private _config!: FullConfig;
  private _runStartedAt = new Date();
  private _results: { test: TestCase, result: TestResult }[] = [];

  printsToStdio() {
    return false;
  }

  onBegin(config: FullConfig) {
    this._config = config;
    this._runStartedAt = new Date();
  }

  onTestEnd(test: TestCase, result: TestResult) {
    this._results.push({ test, result });
  }

  async onEnd() {
    const runId = parseBigInt(process.env.GITHUB_RUN_ID);
    const runAttempt = parseInteger(process.env.GITHUB_RUN_ATTEMPT);
    const workflowName = process.env.GITHUB_WORKFLOW || null;
    const event = process.env.GITHUB_EVENT_NAME || null;
    const prNumber = prNumberFromRef(process.env.GITHUB_REF);
    const botName = process.env.PWTEST_BOT_NAME || (process.env.PW_TAG ? process.env.PW_TAG.replace(/^@/, '') : '');
    const headSha = process.env.GITHUB_SHA || null;
    const headBranch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || null;

    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      await connection.run(`CREATE TABLE IF NOT EXISTS test_results (
  run_id BIGINT,
  run_attempt INTEGER,
  run_started_at TIMESTAMP,
  workflow_name VARCHAR,
  event VARCHAR,
  head_sha VARCHAR,
  head_branch VARCHAR,
  pr_number INTEGER,
  bot_name VARCHAR,
  project_name VARCHAR,
  test_title VARCHAR,
  file VARCHAR,
  -- test_id is intentionally omitted since it's a deterministic hash of (project_name, file, test_title)
  line INTEGER,
  column_number INTEGER,
  expected_status VARCHAR,
  status VARCHAR,
  retry INTEGER,
  result_started_at TIMESTAMP,
  duration_ms BIGINT,
  error_message VARCHAR,
  tags VARCHAR[],
  annotations STRUCT(type VARCHAR, description VARCHAR)[],
)`);
      const appender = await connection.createAppender('test_results');
      for (const { test, result } of this._results) {
        const [, projectName, , ...titles] = test.titlePath();
        appendNullableBigInt(appender, runId);
        appendNullableInteger(appender, runAttempt);
        appendTimestamp(appender, this._runStartedAt);
        appendNullableVarchar(appender, workflowName);
        appendNullableVarchar(appender, event);
        appendNullableVarchar(appender, headSha);
        appendNullableVarchar(appender, headBranch);
        appendNullableInteger(appender, prNumber);
        appender.appendVarchar(botName);
        appender.appendVarchar(projectName);
        appender.appendVarchar(titles.join(' › '));
        appender.appendVarchar(toPosixPath(path.relative(this._config.rootDir, test.location.file)));
        appender.appendInteger(test.location.line);
        appender.appendInteger(test.location.column);
        appender.appendVarchar(test.expectedStatus);
        appender.appendVarchar(result.status);
        appender.appendInteger(result.retry);
        appendTimestamp(appender, result.startTime);
        appender.appendBigInt(BigInt(Math.round(result.duration)));
        appendNullableVarchar(appender, errorMessage(result));
        appender.appendValue(listValue(test.tags), TAGS_TYPE);
        appender.appendValue(listValue(result.annotations.map(annotation => structValue({
          type: annotation.type,
          description: annotation.description ?? '',
        }))), ANNOTATIONS_TYPE);
        appender.endRow();
      }
      appender.flushSync();
      appender.closeSync();
      const outputFile = path.resolve(process.cwd(), process.env.PWTEST_PARQUET_OUTPUT_FILE || 'test-results/test-results.parquet');
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      await connection.run(`COPY test_results TO '${outputFile.replace(/'/g, "''")}' (FORMAT parquet)`);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }
}

function errorMessage(result: TestResult): string | null {
  const messages = (result.errors ?? [])
      .map(error => error.message)
      .filter((message): message is string => !!message)
      .map(message => stripAnsi(message));
  if (!messages.length)
    return null;
  return messages.join('\n\n');
}

function toPosixPath(aPath: string): string {
  return aPath.split(path.sep).join(path.posix.sep);
}

function appendNullableVarchar(appender: DuckDBAppender, value: string | null) {
  if (value === null)
    appender.appendNull();
  else
    appender.appendVarchar(value);
}

function appendNullableInteger(appender: DuckDBAppender, value: number | null) {
  if (value === null)
    appender.appendNull();
  else
    appender.appendInteger(value);
}

function appendNullableBigInt(appender: DuckDBAppender, value: bigint | null) {
  if (value === null)
    appender.appendNull();
  else
    appender.appendBigInt(value);
}

function appendTimestamp(appender: DuckDBAppender, value: Date) {
  // TIMESTAMP is microseconds since the epoch.
  appender.appendTimestamp(timestampValue(BigInt(value.getTime()) * 1000n));
}

function parseBigInt(value: string | undefined): bigint | null {
  if (!value)
    return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function parseInteger(value: string | undefined): number | null {
  if (!value)
    return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function prNumberFromRef(ref: string | undefined): number | null {
  // On pull_request events GITHUB_REF is `refs/pull/<number>/merge`.
  const match = ref?.match(/^refs\/pull\/(\d+)\//);
  return match ? Number.parseInt(match[1], 10) : null;
}

export default ParquetReporter;
