#!/usr/bin/env node --harmony-async-await

require('colors');
const _ = require('lodash');
const fs = require('fs');
const commandLineArgs = require('command-line-args');
const commandLineUsage = require('command-line-usage');
const https = require('https');
const moment = require('moment');
const prompt = require('prompt');
const sequential = require('promise-sequential');
const sprintf = require('sprintf').sprintf;
const truncate = require('truncate');

const configFilePath = `${require('os').homedir()}/.toggl-export`;

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
    if (payload != null) {
      request.write(payload);
    }
    request.end();
  });
}


// apis

async function fetchTogglEntries(token, workspaceId, since, until, page = 1) {
  const json = await jsonRequest({
    host: 'toggl.com',
    path: `/reports/api/v2/details?workspace_id=${workspaceId}&user_agent=time_tracker_export&since=${since.format('YYYY-MM-DD')}&until=${until.format('YYYY-MM-DD')}&page=${page}`,
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

function error(e) {
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
          name: 'config',
          description: 'Update configuration.',
        },
        {
          name: 'since',
          typeLabel: '[underline]{yyyy-mm-dd}',
          description: 'Only export entries logged on or after that date (=until - 1 week).',
        },
        {
          name: 'until',
          typeLabel: '[underline]{yyyy-mm-dd}',
          description: 'Only export entries logged before or on that date (=today).',
        },
        {
          name: 'help',
          description: 'Print this usage guide.',
        },
      ],
    },
  ]));
}

function processEntries(entries, repositories) {
  const parsedEntries = entries.map((entry) => {
    const repository = `${entry.client}/${entry.project}`;
    const repositoryId = repositories.get(repository);
    const description = entry.description.match(/^#(\d+) (.*)$/);

    if (repositoryId != null && description != null) {
      return {
        repository,
        id: repositoryId,
        issueNumber: description[1],
        comment: description[2],
        date: moment(entry.start).startOf('day'),
        dur: entry.dur,
      };
    } else {
      return null;
    }
  });

  const filteredEntries = _.compact(parsedEntries);
  const groupedEntries = _.values(_.groupBy(filteredEntries, entry => [entry.repository, entry.issueNumber, entry.comment, entry.date].join('$')));
  const aggregatedEntries = groupedEntries.map((entry) => {
    const totalDuration = _.sum(entry.map(e => e.dur));
    entry[0].dur = totalDuration;
    entry[0].duration = formatDuration(totalDuration);
    entry[0].dateTime = entry[0].date.format();
    return entry[0];
  });
  return aggregatedEntries;
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
        },
      },
    }, (__, result) => {
      prompt.stop();
      fs.writeFileSync(configFilePath, JSON.stringify(result));
      resolve(result);
    });
  });
}

function readConfig() {
  try {
    const configFile = fs.readFileSync(configFilePath, 'utf8');
    return JSON.parse(configFile);
  } catch (e) {
    return undefined;
  }
}

async function main() {
  const options = commandLineArgs([
    { name: 'help', alias: 'h', type: Boolean, defaultValue: false },
    { name: 'config', alias: 'c', type: Boolean, defaultValue: false },
    { name: 'since', alias: 's', type: moment, defaultValue: moment().startOf('day').subtract(6, 'days'), defaultOption: true },
    { name: 'until', alias: 'u', type: moment, defaultValue: moment().startOf('day') },
  ]);

  if (options.help) {
    printHelp();
    process.exit();
  }

  const config = readConfig();
  if (config === undefined || options.config) {
    await updateConfig(config || {});
    process.stdout.write('Config updated.\n');
    process.exit();
  }

  process.stdout.write('Fetching time-tracker repositories');
  const repositories = await fetchTimeTrackerRepos(config.timeTrackerSession).then(ok, error);

  process.stdout.write(`Looking for time entries from ${options.since.format('Do MMMM YYYY')} until ${options.until.format('Do MMMM YYYY')}`);
  const togglEntries = await fetchTogglEntries(config.togglApiToken, config.togglWorkspaceId, options.since, options.until).then(ok, error);

  const transformedEntries = processEntries(togglEntries, repositories);
  if (transformedEntries.length === 0) {
    process.stdout.write('\nLooks like you didn\'t work at all. Shame on you!\n');
    process.exit();
  }

  process.stdout.write('\nLooks like you actually did some work.\n');

  const groupedByDay = _.groupBy(transformedEntries, entry => entry.date.valueOf());
  const days = _.sortBy(_.keys(groupedByDay));

  days.forEach((day) => {
    const entries = groupedByDay[day];
    const date = entries[0].date;
    process.stdout.write(`\n${date.format('Do MMMM YYYY')}\n`.bold);
    entries.forEach((entry) => {
      process.stdout.write(sprintf('  %7s  %5s %-52s [%s]\n', entry.duration, `#${entry.issueNumber}`, truncate(entry.comment, 50), entry.repository));
    });
  });

  const totalDuration = formatDuration(_.sumBy(transformedEntries, entry => entry.dur));
  process.stdout.write(`\nTotal time: ${totalDuration}\n`.bold);

  process.stdout.write('\nDoes that sound about right? (y/N)\n');
  if (await readKey() !== 'y') {
    process.stdout.write('Goodbye then.\n');
    process.exit();
  }

  process.stdout.write('\nHere we go:\n');
  await sequential(transformedEntries.map(entry => () => {
    process.stdout.write(sprintf('Logging %s on %5s %-52s', entry.duration, `#${entry.issueNumber}`, truncate(entry.comment, 50)));
    return logTime(entry, config.timeTrackerSession).then(ok, error);
  }));

  process.stdout.write('\nDone.\n');
}

main();
