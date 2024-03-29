# file-service

`file-service` is a nodejs service based from express and route file-service provides for abcdesktop :
- `upload` file
- `download` file
- `download directory` ( with zip features )
- `delete` file
- `delete` directory

file-service is used by [oc.filer](https://github.com/abcdesktopio/oc.filer) and [oc.cupsd](https://github.com/abcdesktopio/oc.cupsd) images.


## Features

### sample

#### create a dummy.txt sample file

```bash
echo "Yet another test file" > ~/dummy.txt
```

#### start file-service in background

```bash
DISABLE_REMOTEIP_FILTERING=true yarn start 2>file-service.error  > file-service.log &
```

#### query dummy.txt sample file with curl

```bash
curl http://localhost:29783/filer?file=~/dummy.txt
```

you get

```
Yet another test file
```

#### query /etc/passwd file with curl

```bash
curl http://localhost:29783/filer?file=/etc/passwd
```

you get

```json
{"code":400,"data":"Path Server Error"}
```

### API 

The API documentation is avalable in file [https://github.com/abcdesktopio/file-service/file-service.md](https://github.com/abcdesktopio/file-service/blob/main/file-service.md)

| method   | feature       |
|----------|---------------|
| GET      | [GET file](https://github.com/abcdesktopio/file-service/blob/main/file-service.md#get__ )      |
| POST     | [POST file](https://github.com/abcdesktopio/file-service/blob/main/file-service.md#post__ )    |
| DELETE   | [DELETE file](https://github.com/abcdesktopio/file-service/blob/main/file-service.md#delete__ )|


### GET POST DELETE features 

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

This command installs file service modules.

### to start file-service  

```
DISABLE_REMOTEIP_FILTERING=true yarn start 
```

This command start a file service and listen to the default tcp port.


### to run test

```
CONTAINER_IP=127.0.0.1 yarn test
```

This command run test file one a running file service.


### to make docs 

```
yarn docs
```

This command create a `file-service.md` file.
