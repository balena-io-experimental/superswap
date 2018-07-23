#!/usr/bin/env node
const _ = require("lodash");
const capitano = require("capitano");
const config = require("config");
const fs = require("fs");
const util = require("util");
var PinejsClient = require("pinejs-client");

const env = require("get-env")({
  staging: "staging",
  production: "production",
  devenv: "devenv"
});

const authToken = config.get("authToken");
const authHeader = {
  passthrough: {
    headers: {
      Authorization: `Bearer ${authToken}`
    }
  }
};
const resinApi = new PinejsClient(`${config.get("apiEndpoint")}/v4/`);

async function query_supervisor_releases(tag, device_type) {
  var query_options = {};
  if (device_type) {
    console.log("yeah?");
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

async function releasepairs(from_tag, to_tag, device_type) {
  const from_releases = await query_supervisor_releases(from_tag, device_type);
  const to_releases = await query_supervisor_releases(to_tag, device_type);

  const combos = _.map(to_releases, t => {
    const filtered_from_release = _.filter(from_releases, f => {
      return f.device_type === t.device_type;
    });
    if (filtered_from_release.length === 1) {
      var output = {
        from_supervisor_release: filtered_from_release[0].id,
        to_supervisor_release: t.id,
        device_type: t.device_type
      };
      return output;
    }
  });
  // Filter out `undefined` entries, e.g. where there's 0 or more than 1 release
  // among the candidate `from_releases`, as those are non-actionable.
  return _.filter(combos, c => {
    return c;
  });
}

async function switch_supervisor(from_tag, to_tag, device_type, verbise) {
  const combos = await releasepairs(from_tag, to_tag, device_type);
  _.forEach(combos, async function(c) {
    const device = {
      resource: "device"
    };
    const filter = {
      options: {
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
              supervisor_version: from_tag.slice(1)
            }
          ]
        }
      }
    };
    // console.log(JSON.stringify(_.assign(device, filter, authHeader), null, 2));
    const devices = await resinApi.get(_.assign(device, filter, authHeader));
    const body = {
      body: {
        should_be_managed_by__supervisor_release: c.to_supervisor_release
      }
    };
    var patch_request = _.assign(device, filter, authHeader, body);
    // console.log(JSON.stringify(patch_request, null, 2));
    var response = await resinApi.patch(patch_request);
    console.log(
      `Switching ${c.from_supervisor_release} ->  ${
        c.to_supervisor_release
    } for device type '${c.device_type}':\t${response} :\t${devices.length}`
    );
  });
}

switch_supervisor("v6.6.0", "v6.6.0_logstream");

// test();
//
// const someFunction = () => {
//   console.log("yeah");
// };
//
// capitano.command({
//   signature: "switch",
//   description: "switch",
//   help: "switch",
//   options: [
//     {
//       signature: "from",
//       parameter: "from",
//       boolean: false,
//       alias: ["f"]
//     },
//     {
//       signature: "to",
//       parameter: "to",
//       boolean: false,
//       alias: ["t"]
//     },
//     {
//       signature: "devicetype",
//       parameter: "devicetype",
//       boolean: false,
//       alias: ["d"]
//     },
//     {
//       signature: "verbose",
//       boolean: true,
//       alias: ["v"]
//     }
//   ],
//   action: (params, options) => {
//     console.log(options);
//     if (options.from && options.to) {
//       switch_supervisor(
//         options.from,
//         options.to,
//         options.devicetype,
//         options.verbose
//       );
//       // switch(options.from, options.to, options.devicetype, options.verbose)
//     }
//   }
// });
//
// capitano.command({
//   signature: "help",
//   description: "output general help page",
//   help: "output general help page",
//   action: function() {
//     var command, i, len, ref, results;
//     console.log(`Usage:`);
//     console.log("\nCommands:\n");
//     ref = capitano.state.commands;
//     results = [];
//     for (i = 0, len = ref.length; i < len; i++) {
//       command = ref[i];
//       if (command.isWildcard()) {
//         continue;
//       }
//       results.push(console.log(`\t${command.signature}\t\t\t${command.help}`));
//     }
//     return results;
//   }
// });
//
// capitano.command({
//   signature: "*",
//   action: function() {
//     return capitano.execute({
//       command: "help"
//     });
//   }
// });
//
// capitano.run(process.argv, function(error) {
//   if (error != null) {
//     throw error;
//   }
// });
