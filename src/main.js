#!/usr/bin/env node --harmony-async-await

require('colors');
require('datejs');
const _ = require('lodash');
const fs = require('fs');
const commandLineArgs = require('command-line-args');
const commandLineUsage = require('command-line-usage');
const https = require('https');
const prompt = require('prompt');
const sequential = require('promise-sequential');
const sprintf = require('sprintf').sprintf;
const truncate = require('truncate');

const configFilePath = require('os').homedir() + '/.toggl-export';

// request

async function jsonRequest(options, payload = null) {
  return new Promise((resolve, reject) => {
    const request = https.request(options, (response) => {
      if (response.statusCode !== 200) {
        reject(`${response.statusMessage}`);
      } else {
        let body = '';
        response.on('data', (data) => { body += data; });
        response.on('end', () => { resolve(JSON.parse(body)); });
      }
    }).on('error', (e) => {
      reject(e);
    });
    if (payload !== null) {
      request.write(payload);
    }
    request.end();
  });
}


// apis

async function fetchTogglEntries(token, workspaceId, since, until, page = 1) {
  const json = await jsonRequest({
    host: 'toggl.com',
    path: `/reports/api/v2/details?workspace_id=${workspaceId}&user_agent=time_tracker_export&since=${since.format('Y-m-d')}&until=${until.format('Y-m-d')}&page=${page}`,
    auth: `${token}:api_token`,
  });
  if (json.data.length === 0) {
    return [];
  }
  const entries = await fetchTogglEntries(token, workspaceId, since, until, page + 1);
  return json.data.concat(entries);
}

async function fetchTimeTrackerRepos(session) {
  const repos = await jsonRequest({
    host: 'timer.scm.io',
    path: '/api/repos',
    headers: { Cookie: `time-tracker-session=${session}` },
  });
  return new Map(repos.map(repo => [repo.name, repo.id]));
}

function logTime(entry, session) {
  return jsonRequest({
    host: 'timer.scm.io',
    path: `/api/repos/${entry.id}/issues/${entry.issueNumber}`,
    method: 'POST',
    headers: {
      Cookie: `time-tracker-session=${session}`,
      'Content-Type': 'application/json',
    },
  }, JSON.stringify(entry));
}


// utils

function ok(r) {
  process.stdout.write(' [ ');
  process.stdout.write('OK'.green);
  process.stdout.write(' ]\n');
  return r;
}

function err(e) {
  process.stdout.write(' [ ');
  process.stdout.write(e.red);
  process.stdout.write(' ]\n');
  process.exit();
}

function readKey() {
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  return new Promise(resolve => process.stdin.once('data', (key) => {
    resolve(key);
    process.stdin.unref();
    process.stdin.setRawMode(false);
  }));
}

function formatDuration(milliSeconds) {
  const minutes = Math.round(milliSeconds / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return sprintf('%dh %02dm', h, m);
}


// main

function printHelp() {
  process.stdout.write(commandLineUsage([
    {
      header: 'TogglExport',
      content: 'Exports toggl.com time entries to scalableminds time tracker.',
    },
    {
      header: 'Options',
      optionList: [
        {
          name: 'from',
          typeLabel: '[underline]{yyyy-mm-dd}',
          description: 'Export entries logged on or after that date (until - 1 week).',
        },
        {
          name: 'until',
          typeLabel: '[underline]{yyyy-mm-dd}',
          description: 'Export entries logged before or on that date (today).',
        },
        {
          name: 'config',
          description: 'Update configuration.',
        },
        {
          name: 'help',
          description: 'Print this message.',
        },
      ],
    },
  ]));
}

function readConfig() {
  try {
    const configFile = fs.readFileSync(configFilePath, 'utf8')
    return JSON.parse(configFile);
  } catch (err) {
    return undefined;
  }
}

function updateConfig(oldConfig) {
  return new Promise((resolve) => {
    prompt.message = '';
    prompt.start();
    prompt.get({
      properties: {
        togglApiToken: {
          default: oldConfig.togglApiToken,
          description: 'Enter your toggl.com API token',
          message: 'Invalid token.',
          pattern: /^[0-9a-fA-F]{32}$/,
          required: true,
          type: 'string',
        },
        togglWorkspaceId: {
          default: oldConfig.togglWorkspaceId,
          description: 'Enter your toggl.com workspace id',
          message: 'Invalid workspace id.',
          required: true,
          type: 'number',
        },
        timeTrackerSession: {
          default: oldConfig.timeTrackerSession,
          description: 'Enter your time tracker session id',
          message: 'Invalid session id.',
          pattern: /^[0-9a-zA-Z]{26}$/,
          required: true,
          type: 'string',
        }
      }
    }, (_, result) => {
      prompt.stop();
      fs.writeFileSync(configFilePath, JSON.stringify(result));
      resolve(result);
    });
  });
}

function processEntries(entries, repositories) {
  const parsedEntries = entries.map((entry) => {
    const repository = `${entry.client}/${entry.project}`;
    const description = entry.description.match(/^#(\d+) (.*)$/);
    if (repositories.get(repository) === undefined || description === null) {
      return null;
    }
    return {
      repository,
      id: repositories.get(repository),
      issueNumber: description[1],
      comment: description[2],
      dateTime: new Date(entry.start).clearTime(),
      duration: entry.dur,
    };
  });

  const filteredEntries = _.compact(parsedEntries);
  const groupedEntries = _.values(_.groupBy(filteredEntries, entry => [entry.repository, entry.issueNumber, entry.comment, entry.dateTime].join('$')));
  const aggregatedEntries = groupedEntries.map((entry) => {
    const totalDuration = _.sum(entry.map(e => e.duration));
    entry[0].duration = formatDuration(totalDuration);
    return entry[0];
  });
  return aggregatedEntries;
}

async function main() {
  const options = commandLineArgs([
    { name: 'help', alias: 'h', type: Boolean, defaultValue: false },
    { name: 'config', alias: 'c', type: Boolean, defaultValue: false },
    { name: 'since', alias: 's', type: Date.parse, defaultValue: Date.today().addDays(-6), defaultOption: true },
    { name: 'until', alias: 'u', type: Date.parse, defaultValue: Date.today() },
  ]);

  if (options.help) {
    printHelp();
    process.exit();
  }

  let config = readConfig();
  if (config === undefined || options.config) {
    await updateConfig(config || {});
    process.stdout.write('Config updated.\n');
    process.exit();
  }

  process.stdout.write('Fetching time-tracker repositories');
  const repositories = await fetchTimeTrackerRepos(config.timeTrackerSession).then(ok, err);

  process.stdout.write(`Looking for time entries from '${options.since.format('dS M Y')}' to '${options.until.format('dS M Y')}'`);
  const togglEntries = await fetchTogglEntries(config.togglApiToken, config.togglWorkspaceId, options.since, options.until).then(ok, err);

  const transformedEntries = processEntries(togglEntries, repositories);
  if (transformedEntries.length === 0) {
    process.stdout.write('\nLooks like you didn\'t work at all. Shame on you!\n');
    process.exit();
  }

  process.stdout.write('\nLooks like you actually did some work.\n');

  const groupedByDay = _.groupBy(transformedEntries, entry => entry.dateTime);
  const workdays = _.sortBy(_.keys(groupedByDay).map(Date.parse), date => date.getElapsed()).reverse();

  workdays.forEach((day) => {
    process.stdout.write(`\n${day.format('dS M Y')}\n`.bold);
    groupedByDay[day].forEach((entry) => {
      process.stdout.write(sprintf('  %7s  %5s %-52s [%s]\n', entry.duration, `#${entry.issueNumber}`, truncate(entry.comment, 50), entry.repository));
    });
  });

  process.stdout.write('\nDoes that sound about right? (y/N)\n');
  if (await readKey() !== 'y') {
    process.stdout.write('Goodbye then.\n');
    process.exit();
  }

  process.stdout.write('\nHere we go:\n');
  await sequential(transformedEntries.map(entry => () => {
    process.stdout.write(sprintf('Logging %s on %5s %-52s', entry.duration, `#${entry.issueNumber}`, truncate(entry.comment, 50)));
    return logTime(entry, config.timeTrackerSession).then(ok, err);
  }));

  process.stdout.write('\nDone.\n');
}

main();
