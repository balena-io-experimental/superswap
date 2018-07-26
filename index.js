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

if (process.env.NODE_ENV) {
  const env = require("get-env")({
    staging: "staging",
    production: "production",
    devenv: "devenv"
  });
} else {
  console.log("No NODE_ENV is specified, bailing out.");
  process.exit(1);
}

try {
  const authToken = config.get("authToken");
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
        authToken: body
      };
      jsonfile.writeFile(file, obj, function(err) {
        if (err) {
          console.error(err);
        }
      });
    }
  });

  // resinApi.get({
  //     url: `/user/v1/refresh-token`,
  //     baseUrl: config.get("apiEndpoint")
  //   })
  //   .then(function(response) {
  //     if (response.status === 200) {
  //       var obj = {
  //         apiEndpoint: config.get("apiEndpoint"),
  //         authToken: response.body
  //       };
  //       jsonfile.writeFile(file, obj, function(err) {
  //         if (err) {
  //           console.error(err);
  //         }
  //       });
  //     }
  //   });
};

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

async function releasepairs(from_tag, to_tag, device_type) {
  const from_releases = await query_supervisor_releases(from_tag, device_type);
  const to_releases = await query_supervisor_releases(to_tag, device_type);

  const combos = _.map(to_releases, t => {
    const filtered_from_release = _.filter(from_releases, f => {
      return f.device_type === t.device_type;
    });
    if (filtered_from_release.length === 1) {
      var output = {
        from_supervisor_tag: from_tag,
        from_supervisor_release: filtered_from_release[0].id,
        to_supervisor_tag: to_tag,
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

async function switch_supervisor(
  from_tag,
  to_tag,
  device_type,
  verbose,
  count_only
) {
  const combos = await releasepairs(from_tag, to_tag, device_type);
  _.forEach(combos, async function(c) {
    const device = {
      resource: "device"
    };
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
              supervisor_version: from_tag.slice(1)
            }
          ]
        }
      }
    };
    const ft = c.from_supervisor_tag;
    const fr = c.from_supervisor_release;
    const tt = c.to_supervisor_tag;
    const tr = c.to_supervisor_release;
    const dt = c.device_type;

    if (count_only) {
      const devices = await resinApi.get(_.assign(device, filter, authHeader));
      const count = devices.length;
      console.log(
        `Candidates for ${ft} (${fr}) to ${tt} (${tr}) for type '${dt}': ${count}`
      );
    } else {
      const body = {
        body: {
          should_be_managed_by__supervisor_release: c.to_supervisor_release
        }
      };
      var patch_request = _.assign(device, filter, authHeader, body);
      var response = await resinApi.patch(patch_request);
      console.log(
        `Switching ${ft} (${fr}) to ${tt} (${tr}) for type '${dt}': ${response}`
      );
    }
    sleep.msleep(100);
  });
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
  help: "switch",
  options: cmd_options,
  action: (params, options) => {
    if (options.from && options.to) {
      switch_supervisor(
        options.from,
        options.to,
        options.devicetype,
        options.verbose,
        false
      );
    } else if (options.batchfile) {
      batch_switch_supervisor(options.batchfile, options.verbose, false);
    }
    if (options.refreshtoken) {
      refreshToken();
    }
  }
});

capitano.command({
  signature: "query",
  description: "query",
  help: "query",
  options: cmd_options,
  action: (params, options) => {
    if (options.from && options.to) {
      switch_supervisor(
        options.from,
        options.to,
        options.devicetype,
        options.verbose,
        true
      );
    } else if (options.batchfile) {
      batch_switch_supervisor(options.batchfile, options.verbose, true);
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
