#!/usr/bin/env node
const _ = require("lodash")
const capitano = require("capitano")
const config = require("config")
const jsonfile = require("jsonfile")
const request = require("request-promise")
const PinejsClient = require("pinejs-client")
const semver = require("semver")
const debug = require("debug")("main")
const PubNub = require("pubnub")

if (!process.env.NODE_ENV) {
  console.log("No NODE_ENV is specified, bailing out.")
  process.exit(1)
}

const env = require("get-env")({
  staging: "staging",
  production: "production",
  devenv: "devenv"
})

const authToken = config.get("authToken")

const resinApi = new PinejsClient({
  apiPrefix: `${config.get("apiEndpoint")}/v4/`,
  passthrough: {
    headers: {
      Authorization: `Bearer ${authToken}`
    }
  }
})

const getResource = async function(resource, options) {
  const res = await resinApi.get({ resource, options })
  if (res.length === 0) {
    throw new Error(`ErrNotFound: ${resource}: ${JSON.stringify(options.$filter)}`)
  }
  if (res.length > 1) {
    throw new Error(`ErrMultipleResources: ${resource}: ${JSON.stringify(options.$filter)}`)
  }
  return res[0]
}

const getDeviceBy = $filter => getResource("device", { $filter })
const getSupervisorReleaseBy = $filter => getResource("supervisor_release", { $filter })

// Setup pubnub
const pubnub = new PubNub({
  publishKey: config.get("publishKey"),
  subscribeKey: config.get("subscribeKey"),
  ssl: true
})

const refreshToken = async function() {
  const options = {
    url: `${config.get("apiEndpoint")}/user/v1/refresh-token`,
    headers: {
      Authorization: `Bearer ${authToken}`
    }
  }
  const res = await request(options)

  const obj = {
    apiEndpoint: config.get("apiEndpoint"),
    authToken: res.body,
    publishKey: config.get("publishKey"),
    subscribeKey: config.get("subscribeKey")
  }

  const file = `./config/${env}.json`
  await jsonfile.writeFile(file, obj)
}

const getUserToken = async function(username) {
  const options = {
    url: `${config.get("apiEndpoint")}/login_`,
    headers: {
      Authorization: `Bearer ${authToken}`
    },
    json: { username: username },
    method: "PATCH"
  }

  const token = await request(options)
  if (!token) {
    throw new Error(`ErrTokenNotFound: ${username}`)
  }
  return token
}

const releasepairs = async function(fromTag, toTag, device_type) {
  const from_releases = await query_supervisor_releases(fromTag, device_type)
  const to_releases = await query_supervisor_releases(toTag, device_type)

  const combos = _.map(to_releases, t => {
    const filtered_from_release = _.filter(from_releases, f => f.device_type === t.device_type)
    if (filtered_from_release.length === 1) {
      var output = {
        from_supervisor_tag: fromTag,
        from_supervisor_release: filtered_from_release[0].id,
        to_supervisor_tag: toTag,
        to_supervisor_release: t.id,
        device_type: t.device_type
      }
      return output
    }
  })
  // Filter out `undefined` entries, e.g. where there's 0 or more than 1 release
  // among the candidate `from_releases`, as those are non-actionable.
  return _.filter(combos, c => {
    return c
  })
}

const switch_supervisor = async function(fromTag, toTag, device_type, count_only) {
  const combos = await releasepairs(fromTag, toTag, device_type)
  _.forEach(combos, async function(c) {
    const device = {
      resource: "device"
    }
    const filter = {
      options: {
        $select: "id",
        $filter: {
          $or: [
            {
              should_be_managed_by__supervisor_release: {
                $any: {
                  $alias: "supervisor_release",
                  $expr: {
                    supervisor_release: { id: c.from_supervisor_release }
                  }
                }
              }
            },
            {
              device_type: c.device_type,
              should_be_managed_by__supervisor_release: null,
              supervisor_version: fromTag.slice(1)
            }
          ]
        }
      }
    }
    const ft = c.from_supervisor_tag
    const fr = c.from_supervisor_release
    const tt = c.to_supervisor_tag
    const tr = c.to_supervisor_release
    const dt = c.device_type

    if (count_only) {
      const devices = await resinApi.get(_.assign(device, filter))
      const count = devices.length
      console.log(`Candidates for ${ft} (${fr}) to ${tt} (${tr}) for type '${dt}': ${count}`)
    } else {
      const body = {
        body: {
          should_be_managed_by__supervisor_release: c.to_supervisor_release
        }
      }
      var patch_request = _.assign(device, filter, body)
      var response = await resinApi.patch(patch_request)
      console.log(`Switching ${ft} (${fr}) to ${tt} (${tr}) for type '${dt}': ${response}`)
    }
  })
}

/**
 * Update the supervisor on a single device
 *
 * @param   {string} uuid
 * @param   {string} fromTag
 * @param   {string} toTag
 * @param   {boolean} dryRun
 *
 */
const switchSupervisorSingle = async function(uuid, fromTag, toTag, dryRun) {
  const device = await getResource("device", {
    $expand: "belongs_to__user",
    $filter: { uuid }
  })

  debug(`Device type for '${uuid}' is '${device.device_type}'`)

  const fromRelease = await getSupervisorReleaseBy({supervisor_version: fromTag, device_type: device.device_type}).then(r => r.id).catch(e => null)
  const toRelease = await getSupervisorReleaseBy({supervisor_version: toTag, device_type: device.device_type}).then(r => r.id)
  const deviceRelease = device.should_be_managed_by__supervisor_release.__id || null

  debug("fromRelease", fromRelease, "toRelease", toRelease, "deviceRelease", deviceRelease)

  if (deviceRelease !== null && deviceRelease !== fromRelease) {
    throw new Error(`Unexpected supervisor release. expected ${fromRelease} or null, found ${deviceRelease}`)
  }

  // The supervisor reports main semver, so a tag `'v7.4.3'` would be reported as
  // '7.4.3' in the `supervisor_version` field of the device.
  // This would be the case for the tag 'v7.4.3_logstream' as well
  // With this coertion, we'll get a cleaned up version of the tag, that matches
  // what should be reported.
  const fromVersion = semver.coerce(fromTag).version

  if (device.supervisor_version !== fromVersion) {
    throw new Error(`Unexpected supervisor version. expected ${fromVersion}, found ${device.supervisor_version}`)
  }

  console.log(`Found matching and eligible device: ${uuid} (logs channel: ${device.logs_channel})`)

  if (dryRun) {
    return
  }

  const userAuthToken = await getUserToken(device.belongs_to__user[0].username)

  // Run the actual update
  const patchOpts = {
    resource: "device",
    options: {
      $filter: {
        uuid: uuid,
        should_be_managed_by__supervisor_release: deviceRelease
      }
    },
    body: {
      should_be_managed_by__supervisor_release: toRelease
    },
    passthrough: {
      headers: {
        Authorization: `Bearer ${userAuthToken}`
      }
    }
  }
  debug("patching device. filter:", JSON.stringify(patchOpts.options.$filter), "body:", JSON.stringify(patchOpts.body))

  const res = await resinApi.patch(patchOpts)
  if (res !== "OK") {
    throw new Error(`Patch request didn't return OK for UUID '${uuid}'`)
  }

  try {
    await getDeviceBy({uuid, should_be_managed_by__supervisor_release: toRelease})
  } catch (e) {
    throw new Error("Device changed supervisor release after reading.")
  }

  // Add tombstone log
  const publishConfig = {
    channel: `device-${uuid}-logs`,
    message: [{
      t: Date.now(),
      m: "Logging functionality will be disabled for old clients, please update to at least SDK v9.0.4 or CLI v7.8.3"
    }]
  }

  debug("Sending tombstone log to channel:", publishConfig.channel)
  await new Promise((resolve, reject) => {
    pubnub.publish(publishConfig, status => {
      if (status.statusCode !== 200) {
        throw new Error(`PubNub tombstone failed for UUID ${uuid} with status code '${status.statusCode}'`)
      }
      resolve()
    })
  })

  console.log(`Supervisor patched for UUID: '${uuid}'`)
}

async function batch_switch_supervisor(versionsfile, count_only) {
  jsonfile.readFile(versionsfile, function(err, versions) {
    _.forEach(versions, v => {
      if (v.fromTag && v.toTag) {
        switch_supervisor(v.fromTag, v.toTag, v.device_type, count_only)
      }
    })
  })
}

/*
* commmand line setup
*/

// Common options for `query` and `switch`
const cmd_options = [
  {
    signature: "from",
    parameter: "from",
    boolean: false,
    alias: ["f"]
  },
  {
    signature: "to",
    parameter: "to",
    boolean: false,
    alias: ["t"]
  },
  {
    signature: "batchfile",
    parameter: "batchfile",
    boolean: false,
    alias: ["b"]
  },
  {
    // This can be multiple
    signature: "uuid",
    parameter: "uuid",
    boolean: false,
    alias: ["u"]
  },
  {
    signature: "verbose",
    boolean: true,
    alias: ["v"]
  },
  {
    signature: "refreshtoken",
    boolean: true,
    alias: ["r"]
  }
]

capitano.command({
  signature: "switch",
  description: "switch",
  help:
    "switch -f/--from -t/--to -u/--uuid -b/--batchfile -v/--verbose -r/--refreshtoken",
  options: cmd_options,
  action: (params, options) => {
    debug.enabled = options.verbose

    if (options.uuid) {
      switchSupervisorSingle(options.uuid, options.from, options.to, false)
    }
    if (options.refreshtoken) {
      refreshToken()
    }
    // if (options.from && options.to) {
    //   switch_supervisor(options.from, options.to, false)
    // } else if (options.batchfile) {
    //   batch_switch_supervisor(options.batchfile, false)
    // }
  }
})

capitano.command({
  signature: "query",
  description: "query",
  help:
    "query -f/--from -t/--to -u/--uuid -b/--batchfile -v/--verbose -r/--refreshtoken",
  options: cmd_options,
  action: (params, options) => {
    debug.enabled = options.verbose
    // if (options.from && options.to) {
    //   switch_supervisor(options.from, options.to, options.devicetype, true)
    // } else if (options.batchfile) {
    //   batch_switch_supervisor(options.batchfile, true)
    // }

    if (options.uuid) {
      switchSupervisorSingle(options.uuid, options.from, options.to, true)
    }
    if (options.refreshtoken) {
      refreshToken()
    }
  }
})

capitano.command({
  signature: "help",
  description: "output general help page",
  help: "output general help page",
  action: function() {
    var command, i, len, ref, results
    console.log(`Usage:`)
    console.log("\nCommands:\n")
    ref = capitano.state.commands
    results = []
    for (i = 0, len = ref.length; i < len; i++) {
      command = ref[i]
      if (command.isWildcard()) {
        continue
      }
      results.push(console.log(`\t${command.signature}\t\t\t${command.help}`))
    }
    return results
  }
})

capitano.command({
  signature: "*",
  action: function() {
    return capitano.execute({
      command: "help"
    })
  }
})

capitano.run(process.argv, function(error) {
  if (error != null) {
    throw error
  }
})
