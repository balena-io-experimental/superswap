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

// console.log(_.assign({'a': 'b'},authHeader, {'x':'z'}))
// console.log(authHeader)

async function switch_supervisor(from_tag, to_tag, device_type, verbose) {
  // Supervisor tag of the supervisor to replace
  var supervisor_tag = from_tag;
  // var supervisor_replacement_tag = `${supervisor_tag}_logstream`;
  var supervisor_replacement_tag = to_tag;
  // Target device type
  // var device_type = "intel-nuc";
  console.log("NEW!");

  // Find corresponding supervisor release, if there's any
  var releases = await resinApi.get({
    resource: "supervisor_release",
    options: {
      $select: "id",
      $filter: {
        device_type: device_type,
        supervisor_version: supervisor_tag
      }
    }
  });
  console.log(releases);

  // Find corresponding supervisor release, if there's any
  var replacement_releases = await resinApi.get({
    resource: "supervisor_release",
    options: {
      $select: "id",
      $filter: {
        device_type: device_type,
        supervisor_version: supervisor_replacement_tag
      }
    }
  });
  console.log(replacement_releases);

  if (releases.length === 1 && replacement_releases.length === 1) {
    var supervisor_release = releases[0].id;
    var supervisor_replacement_release = replacement_releases[0].id;
    console.log(`Starting supervisor release: ${supervisor_release}`);
    // Find devices reported the target supervisor version (note, it's without the starting `v`!),
    // and either didn't have target supervisor set explicitly, or are set to the same one as reported.
    var device = {
      resource: "device"
    };
    var filter = {
      options: {
        $filter: {
          $or: [
            {
              should_be_managed_by__supervisor_release: {
                $any: {
                  $alias: "supervisor_release",
                  $expr: {
                    supervisor_release: { id: supervisor_release }
                  }
                }
              }
            },
            {
              device_type: device_type,
              should_be_managed_by__supervisor_release: null,
              supervisor_version: supervisor_tag.slice(1)
            }
          ]
        }
      }
    };
    console.log(JSON.stringify(_.assign(device, filter, authHeader), null, 2));
    var devices = await resinApi.get(_.assign(device, filter, authHeader));
    console.log(devices);
    var body = {
      body: {
        should_be_managed_by__supervisor_release: supervisor_replacement_release
      }
    };
    var patch_request = _.assign(device, filter, authHeader, body);
    console.log(JSON.stringify(patch_request, null, 2));
    var response = await resinApi.patch(patch_request);
    console.log(response);
  }
}

// test();

const someFunction = () => {
  console.log("yeah");
};

capitano.command({
  signature: "switch",
  description: "switch",
  help: "switch",
  options: [
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
      signature: "verbose",
      boolean: true,
      alias: ["v"]
    }
  ],
  action: (params, options) => {
    console.log(options);
    if (options.from && options.to) {
        switch_supervisor(options.from, options.to, options.devicetype, options.verbose)
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
