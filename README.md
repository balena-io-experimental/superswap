# Supervisor Swapper

## Setup

In `./config/`, set up a configuration `${envname}.json` file with the name that will be your environment.
Currently accepted values are:

- `staging` -> `staging.json`
- `production` -> `production.json`
- `devenv` -> `devenv.json`

Inside need to provide four configuration options:

```
{
    "apiEndpoint": "https://aaaaa.bbbbbb.ccc",
    "authToken":"xxx",
    "publishKey":"yyy",
    "subscribeKey":"zzz"
}
```

where the `apiEndpoint` is the API endpoint, `authToken` is a `JWT` token from the dashboard, `publishKey` and `subscribeKey` are the relevant PubSub keys for the environment.

Running the script:

Query whether a device can be updated from a given supervor to the other:

```
NODE_ENV=staging node index.js query -f vA.B.C -t vX.Y.Z -u UUID
```

Running the actual update on the device:

```
NODE_ENV=staging node index.js switch -f vA.B.C -t vX.Y.Z -u UUID
```

Commands:

- `query`: just gather information about the update
- `switch`: do the actual update

Flags:

- `-f/--from <tag>`: starting supervisor tag to update _from_
- `-t/--to <tag>`: target supervisor tag to update _to_
- `-u/--uuid <uuid>`: UUID of target device
- `-d/--devicetype`: device type specified (optional)
- `-v/--verbose`: verbose output (WIP)
- `-b/--batchfile`: use a JSON to specify a collection of supervisors to consider (WIP)
- `-r/--refreshtoken`: refresh the JWT token during the run
