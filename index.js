#!/usr/bin/env node
const _ = require("lodash");
const capitano = require("capitano");
const config = require("config");
const fs = require("fs");
const util = require("util");
const jsonfile = require("jsonfile");
const sleep = require("sleep");
const request = require("request");
const PinejsClient = require("pinejs-client");
const semver = require("semver");
const PubNub = require("pubnub");

var env;
if (process.env.NODE_ENV) {
  env = require("get-env")({
    staging: "staging",
    production: "production",
    devenv: "devenv"
  });
} else {
  console.log("No NODE_ENV is specified, bailing out.");
  process.exit(1);
}

var authToken;
try {
  authToken = config.get("authToken");
} catch (e) {
  console.log("Can't read authToken from the config file, bailing out.");
  process.exit(2);
}
const authHeader = {
  passthrough: {
    headers: {
      Authorization: `Bearer ${authToken}`
    }
  }
};
const resinApi = new PinejsClient(`${config.get("apiEndpoint")}/v4/`);

// Setup pubnub
pubnub = new PubNub({
  publishKey: config.get("publishKey"),
  subscribeKey: config.get("subscribeKey"),
  ssl: true
});

var refreshToken = async function() {
  const file = `./config/${env}.json`;
  var options = {
    url: `${config.get("apiEndpoint")}/user/v1/refresh-token`,
    headers: {
      Authorization: `Bearer ${authToken}`
    }
  };
  request(options, (err, resp, body) => {
    if (err) {
      console.log(err);
    } else {
      var obj = {
        apiEndpoint: config.get("apiEndpoint"),
        authToken: body,
        publishKey: config.get("publishKey"),
        subscribeKey: config.get("subscribeKey")
      };
      jsonfile.writeFile(file, obj, function(err) {
        if (err) {
          console.error(err);
        }
      });
    }
  });
};

/**
 * Get the supervisor releases for a given supervisor tag, narrowed by
 * an optional device type
 *
 * @param   {string} tag
 * @param   {string} device_type (optional)
 *
 * @return  {array} the list of matching supervisor releases found
 */
async function query_supervisor_releases(tag, device_type) {
  var query_options = {};
  if (device_type) {
    query_options = {
      options: {
        $select: ["id", "device_type"],
        $filter: {
          device_type: device_type,
          supervisor_version: tag
        }
      }
    };
  } else {
    query_options = {
      options: {
        $select: ["id", "device_type"],
        $filter: {
          supervisor_version: tag
        }
      }
    };
  }
  const query = {
    resource: "supervisor_release"
  };

  return resinApi.get(_.assign(query, query_options));
}

// async function releasepairs(from_tag, to_tag, device_type) {
//   const from_releases = await query_supervisor_releases(from_tag, device_type);
//   const to_releases = await query_supervisor_releases(to_tag, device_type);
//
//   const combos = _.map(to_releases, t => {
//     const filtered_from_release = _.filter(from_releases, f => {
//       return f.device_type === t.device_type;
//     });
//     if (filtered_from_release.length === 1) {
//       var output = {
//         from_supervisor_tag: from_tag,
//         from_supervisor_release: filtered_from_release[0].id,
//         to_supervisor_tag: to_tag,
//         to_supervisor_release: t.id,
//         device_type: t.device_type
//       };
//       return output;
//     }
//   });
//   // Filter out `undefined` entries, e.g. where there's 0 or more than 1 release
//   // among the candidate `from_releases`, as those are non-actionable.
//   return _.filter(combos, c => {
//     return c;
//   });
// }
//
// async function switch_supervisor(
//   from_tag,
//   to_tag,
//   device_type,
//   verbose,
//   count_only
// ) {
//   const combos = await releasepairs(from_tag, to_tag, device_type);
//   _.forEach(combos, async function(c) {
//     const device = {
//       resource: "device"
//     };
//     const filter = {
//       options: {
//         $select: "id",
//         $filter: {
//           $or: [
//             {
//               should_be_managed_by__supervisor_release: {
//                 $any: {
//                   $alias: "supervisor_release",
//                   $expr: {
//                     supervisor_release: { id: c.from_supervisor_release }
//                   }
//                 }
//               }
//             },
//             {
//               device_type: c.device_type,
//               should_be_managed_by__supervisor_release: null,
//               supervisor_version: from_tag.slice(1)
//             }
//           ]
//         }
//       }
//     };
//     const ft = c.from_supervisor_tag;
//     const fr = c.from_supervisor_release;
//     const tt = c.to_supervisor_tag;
//     const tr = c.to_supervisor_release;
//     const dt = c.device_type;
//
//     if (count_only) {
//       const devices = await resinApi.get(_.assign(device, filter, authHeader));
//       const count = devices.length;
//       console.log(
//         `Candidates for ${ft} (${fr}) to ${tt} (${tr}) for type '${dt}': ${count}`
//       );
//     } else {
//       const body = {
//         body: {
//           should_be_managed_by__supervisor_release: c.to_supervisor_release
//         }
//       };
//       var patch_request = _.assign(device, filter, authHeader, body);
//       var response = await resinApi.patch(patch_request);
//       console.log(
//         `Switching ${ft} (${fr}) to ${tt} (${tr}) for type '${dt}': ${response}`
//       );
//     }
//     sleep.msleep(100);
//   });
// }

/**
 * Update the supervisor on a single device
 *
 * @param   {string} uuid
 * @param   {string} from_tag
 * @param   {number} to_tag
 * @param   {string} to_tag
 * @param   {number} to_release
 * @param   {string} device_type
 * @param   {boolean} query_only
 * @param   {boolen} verbose
 *
 */
async function switch_supervisor_single(
  uuid,
  from_tag,
  from_release,
  to_tag,
  to_release,
  device_type,
  query_only,
  verbose
) {
  const device_resource = {
    resource: "device"
  };
  // Get device type if not specified
  if (!device_type) {
    const device_type_filter = {
      options: {
        $select: "device_type",
        $filter: {
          uuid: uuid
        }
      }
    };
    const result = await resinApi.get(
      _.assign(device_resource, device_type_filter, authHeader)
    );
    if (result.length === 1) {
      device_type = result[0].device_type;
      if (verbose) {
        console.log(`Device type for '${uuid}' is '${device_type}'`);
      }
    } else {
      console.log(`Couldn't find device with UUID = ${uuid}`);
      return;
    }
  }

  // Get "from" supervisor release if not given
  if (!from_release && from_tag) {
    const result = await query_supervisor_releases(from_tag, device_type);
    if (result.length === 1) {
      from_release = result[0].id;
      if (verbose) {
        console.log(
          `Supervisor release for tag '${from_tag}' and device type '${device_type}' is ${from_release}`
        );
      }
    } else {
      console.log(
        `Couldn't find supervisor for tag '${from_tag}' and device type '${device_type}'`
      );
      return;
    }
  } else if (!from_tag) {
    console.log(
      `Cannot work without supervisor releases specified for UUID = ${uuid}`
    );
    return;
  }
  // The supervisor reports main semver, so a tag `'v7.4.3'` would be reported as
  // '7.4.3' in the `supervisor_version` field of the device.
  // This would be the case for the tag 'v7.4.3_logstream' as well
  // With this coertion, we'll get a cleaned up version of the tag, that matches
  // what should be reported.
  const coerced_from_tag = semver.coerce(from_tag).version;

  // Get "to" supervisor release if not given
  if (!to_release && to_tag) {
    const result = await query_supervisor_releases(to_tag, device_type);
    if (result.length === 1) {
      to_release = result[0].id;
      if (verbose) {
        console.log(
          `Supervisor release for tag '${to_tag}' and device type '${device_type}' is ${to_release}`
        );
      }
    } else {
      console.log(
        `Couldn't find supervisor for tag '${to_tag}' and device type '${device_type}'`
      );
      return;
    }
  } else if (!to_tag) {
    console.log(
      `Cannot work without supervisor releases specified for UUID = ${uuid}`
    );
    return;
  }

  // Filter for to get the right & eligible device
  const starting_filter = {
    options: {
      $select: "uuid",
      $filter: {
        uuid: uuid,
        $or: [
          {
            should_be_managed_by__supervisor_release: {
              $any: {
                $alias: "supervisor_release",
                $expr: {
                  supervisor_release: { id: from_release }
                }
              }
            }
          },
          {
            device_type: device_type,
            should_be_managed_by__supervisor_release: null,
            supervisor_version: coerced_from_tag
          }
        ]
      }
    }
  };

  const device = await resinApi.get(
    _.assign(device_resource, starting_filter, authHeader)
  );
  if (device.length !== 1) {
    console.log(`No eligible device found`);
    return;
  } else {
    if (query_only) {
      // Only find the device that we we aim to update
      console.log(`Found matching and eligible device: ${uuid}`);
      return;
    } else {
      // Run the actual update
      const patch_body = {
        body: {
          should_be_managed_by__supervisor_release: to_release
        }
      };
      const patch_request = _.assign(
        device_resource,
        starting_filter,
        authHeader,
        patch_body
      );
      const patch_response = await resinApi.patch(patch_request);
      if (patch_response === "OK") {
        // If the device was successfully updated, this filter should catch it
        const crosscheck_filter = {
          options: {
            $select: "logs_channel",
            $filter: {
              uuid: uuid,
              should_be_managed_by__supervisor_release: {
                $any: {
                  $alias: "supervisor_release",
                  $expr: {
                    supervisor_release: { id: to_release }
                  }
                }
              }
            }
          }
        };
        const device = await resinApi.get(
          _.assign(device_resource, crosscheck_filter, authHeader)
        );
        if (device.length === 1) {
          if (device[0].logs_channel !== null) {
            // Add tombstone log
            var publishConfig = {
              channel: `device-${uuid}-logs`,
              message: [
                {
                  t: Date.now(),
                  m:
                    "Logging functionality will be disabled for old clients, please update to at least SDK vX.Y.Z or CLI vA.B.C"
                }
              ]
            };
            pubnub.publish(publishConfig, function(status, response) {
              if (status.statusCode !== 200) {
                console.log(
                  `PubNub tombstone failed for UUID ${uuid} with status code '${
                    status.statusCode
                  }'`
                );
              }
            });
          }
          console.log(`Supervisor patched for UUID: '${uuid}'`);
        } else {
          console.log(
            `Update didn't seem to happen, device might not be eligible or has changed recently: '${uuid}'`
          );
          return;
        }
      } else {
        console.log(`Patch request didn't return OK for UUID '${uuid}'`);
      }
    }
  }
}

async function batch_switch_supervisor(versionsfile, verbose, count_only) {
  jsonfile.readFile(versionsfile, function(err, versions) {
    _.forEach(versions, v => {
      if (v.from_tag && v.to_tag) {
        switch_supervisor(
          v.from_tag,
          v.to_tag,
          v.device_type,
          verbose,
          count_only
        );
      }
    });
  });
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
    signature: "devicetype",
    parameter: "devicetype",
    boolean: false,
    alias: ["d"]
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
];

capitano.command({
  signature: "switch",
  description: "switch",
  help:
    "switch -f/--from -t/--to -u/--uuid -d/--devicetype -b/--batchfile -v/--verbose -r/--refreshtoken",
  options: cmd_options,
  action: (params, options) => {
    if (!options.verbose) {
      options.verbose = false;
    }
    if (options.uuid) {
      switch_supervisor_single(
        options.uuid,
        options.from,
        null,
        options.to,
        null,
        options.devicetype,
        false,
        options.verbose
      );
    }
    if (options.refreshtoken) {
      refreshToken();
    }
    // if (options.from && options.to) {
    //   switch_supervisor(
    //     options.from,
    //     options.to,
    //     options.devicetype,
    //     options.verbose,
    //     false
    //   );
    // } else if (options.batchfile) {
    //   batch_switch_supervisor(options.batchfile, options.verbose, false);
    // }
    // if (options.refreshtoken) {
    //   refreshToken();
    // }
  }
});

capitano.command({
  signature: "query",
  description: "query",
  help:
    "query -f/--from -t/--to -u/--uuid -d/--devicetype -b/--batchfile -v/--verbose -r/--refreshtoken",
  options: cmd_options,
  action: (params, options) => {
    // if (options.from && options.to) {
    //   switch_supervisor(
    //     options.from,
    //     options.to,
    //     options.devicetype,
    //     options.verbose,
    //     true
    //   );
    // } else if (options.batchfile) {
    //   batch_switch_supervisor(options.batchfile, options.verbose, true);
    // }
    // if (options.refreshtoken) {
    //   refreshToken();
    // }
    if (!options.verbose) {
      options.verbose = false;
    }
    if (options.uuid) {
      switch_supervisor_single(
        options.uuid,
        options.from,
        null,
        options.to,
        null,
        options.devicetype,
        true,
        options.verbose
      );
    }
    if (options.refreshtoken) {
      refreshToken();
    }
  }
});

capitano.command({
  signature: "help",
  description: "output general help page",
  help: "output general help page",
  action: function() {
    var command, i, len, ref, results;
    console.log(`Usage:`);
    console.log("\nCommands:\n");
    ref = capitano.state.commands;
    results = [];
    for (i = 0, len = ref.length; i < len; i++) {
      command = ref[i];
      if (command.isWildcard()) {
        continue;
      }
      results.push(console.log(`\t${command.signature}\t\t\t${command.help}`));
    }
    return results;
  }
});

capitano.command({
  signature: "*",
  action: function() {
    return capitano.execute({
      command: "help"
    });
  }
});

capitano.run(process.argv, function(error) {
  if (error != null) {
    throw error;
  }
});
