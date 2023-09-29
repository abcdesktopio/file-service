# file-service

`file-service` is a nodejs service based from express and route file-service provides for abcdesktop :
- `upload` file
- `download` file
- `download directory` ( with zip features )
- `delete` file
- `delete` directory

file-service is used by oc.filer and oc.cupsd images


## Features

### GET PUT DELETE features 

Each main features can de disable by env vars.

| var name         | feature                                  |
|------------------|------------------------------------------|
| SENDFILE         | Allow http get                           |
| ACCEPTFILE       | Allow http put                           |
| ACCEPTLISTFILE   | Allow http list file (use json format)   |
| ACCEPTDELETEFILE | Allow http delete                        |

To disable a feature, set env var to `false`

```
export ACCEPTDELETEFILE=false
yarn start 
```

To enable a feature, set env var to `true`.
Be default all features are enabled.

```
export ACCEPTDELETEFILE=true
yarn start 
```

### tcp port 

The defautl tcp port for this http service is `29783`

```
process.env.FILE_SERVICE_TCP_PORT || 29783
```

### filtering

By default each http request must come from the nginx reverse proxy source ip addr. To disable ip source filter set the `DISABLE_REMOTEIP_FILTERING` to true

```
export DISABLE_REMOTEIP_FILTERING=true
```

All requested files must be located inside the user home directory. The root direcotry is equal to the user's home directory.

```
rootdir = process.env.HOME
```

## run 

### to install 

```
yarn install
```

### to start file-service  

```
DISABLE_REMOTEIP_FILTERING=true yarn start 
```

### to run test

```
mkdir -p ~/.wallpapers
CONTAINER_IP=127.0.0.1 yarn test
```
