/*
* Software Name : abcdesktop.io
* Version: 0.2
* SPDX-FileCopyrightText: Copyright (c) 2020-2021 Orange
* SPDX-License-Identifier: GPL-2.0-only
*
* This software is distributed under the GNU General Public License v2.0 only
* see the "license.txt" file for more details.
*
* Author: abcdesktop.io team
* Software description: cloud native desktop service
*/

const fs = require('fs');
const fsextra = require('fs-extra');
const { spawn } = require('child_process');
const util = require('util');
const express = require('express');
const asyncHandler = require('express-async-handler');
const helmet = require('helmet');
const path = require('path');
const multer = require('multer');
const JSZip = require('jszip');
const { pipeline } = require('stream');
const { listenDaemonOnContainerIpAddr } = require('oc.user.libraries');

const {
  middleWareFileQuery,
  middleWareFileBody,
  middlewareCheckFile,
  middleWareDirectoryQuery,
} = require('./middlewares');

// Helper function to check if a file or directory exists
// as fs.exists is deprecated
async function exists(p) {
  try { await fs.promises.access(p); return true; }
  catch { return false; }
}

// ---------------------------------------------------------------------------
// Logger — levels : error(0) warn(1) info(2) debug(3)
// Controlled by LOG_LEVEL (default: 'info' in production, 'debug' if NODE_ENV=development)
// ---------------------------------------------------------------------------
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const DEFAULT_LEVEL = process.env.NODE_ENV === 'development' ? 'debug' : 'info';
const CURRENT_LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS[DEFAULT_LEVEL];

const logger = {
  error: (msg, ...args) => { if (CURRENT_LOG_LEVEL >= 0) console.error(`[ERROR] ${msg}`, ...args); },
  warn:  (msg, ...args) => { if (CURRENT_LOG_LEVEL >= 1) console.warn( `[WARN]  ${msg}`, ...args); },
  info:  (msg, ...args) => { if (CURRENT_LOG_LEVEL >= 2) console.log(  `[INFO]  ${msg}`, ...args); },
  debug: (msg, ...args) => { if (CURRENT_LOG_LEVEL >= 3) console.log(  `[DEBUG] ${msg}`, ...args); },
};
// ---------------------------------------------------------------------------

const rootdir = process.env.HOME;
const PORT = process.env.FILE_SERVICE_TCP_PORT || 29783;
const ALLOW_TO_SENDFILE = is_allow_var( process.env.SENDFILE) ;
const ALLOW_TO_ACCEPTFILE = is_allow_var( process.env.ACCEPTFILE );
const ALLOW_TO_LISTFILE = is_allow_var( process.env.ACCEPTLISTFILE );
const ALLOW_TO_DELETEFILE = is_allow_var( process.env.ACCEPTDELETEFILE );
const ALLOW_BINARIES_UPLOAD = process.env.ACCEPT_BINARIES_UPLOAD ? is_allow_var( process.env.ACCEPT_BINARIES_UPLOAD ) : false;
const ALLOW_COMPRESSED_UPLOAD = process.env.ACCEPT_COMPRESSED_UPLOAD ? is_allow_var( process.env.ACCEPT_COMPRESSED_UPLOAD ) : false;
const UPLOAD_SIZE_LIMIT = parseInt(process.env.UPLOAD_SIZE_LIMIT) || 1000 * 1024 * 1024;

const DENIED_REQUEST_FILE_RESPONSE = { code: 403, data: 'Forbidden' };

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPLOAD_SIZE_LIMIT } });

logger.info(`Service is listening on port ${PORT}`);
logger.debug(`Root dir is ${rootdir}`);
logger.info(`Current log level is ${CURRENT_LOG_LEVEL}`)
logger.info(`ALLOW_TO_SENDFILE=${ALLOW_TO_SENDFILE}`);
logger.info(`ALLOW_TO_ACCEPTFILE=${ALLOW_TO_ACCEPTFILE}`);
logger.info(`ALLOW_TO_LISTFILE=${ALLOW_TO_LISTFILE}`);
logger.info(`ALLOW_TO_DELETEFILE=${ALLOW_TO_DELETEFILE}`);
logger.info(`ALLOW_BINARIES_UPLOAD=${ALLOW_BINARIES_UPLOAD}`);
logger.info(`ALLOW_COMPRESSED_UPLOAD=${ALLOW_COMPRESSED_UPLOAD}`);
logger.info(`UPLOAD_SIZE_LIMIT=${UPLOAD_SIZE_LIMIT}`);


// MIME types whose execution could be dangerous on a desktop container.
const BLOCKED_MIME_TYPES = new Set([
  'application/x-elf',              // Linux ELF binary
  'application/x-executable',       // generic executable
  'application/x-sharedlib',        // .so shared library
  'application/x-object',           // .o compiled object
  'application/x-msdownload',       // Windows PE/DLL
  'application/x-dex',              // Android DEX
  'application/x-mach-binary',      // macOS Mach-O
  'text/x-shellscript',             // shell script
]);

// Compressed archive formats — can embed executables or be used for zip bombs.
const COMPRESSED_MIME_TYPES = new Set([
  'application/zip',                // .zip
  'application/x-7z-compressed',   // .7z
  'application/x-rar-compressed',  // .rar
  'application/gzip',              // .tar.gz / .tgz
  'application/x-bzip2',           // .tar.bz2
  'application/x-xz',             // .tar.xz
  'application/zstd',              // .tar.zst
  'application/x-rpm',              // .rpm
  'application/x-iso9660-image',  // .iso
]);

/**
 * Returns the MIME type of a buffer by piping it to the `file` command via stdin.
 * No temp file, no filename involved — immune to command injection.
 */
function getMimeTypeFromBuffer(buf) {
  return new Promise((resolve, reject) => {
    // '--mime-type' : print only the MIME type
    // '-b'          : brief mode, no filename prefix
    // '-'           : read from stdin
    const proc = spawn('file', ['--mime-type', '-b', '-']);
    let output = '';
    let error = '';

    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.stderr.on('data', (data) => { error += data.toString(); });
    proc.on('error', reject);

    proc.stdin.write(buf);
    proc.stdin.end();

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`file command exited with code ${code}: ${error.trim()}`));
      } else {
        resolve(output.trim());
      }
    });
  });
}

async function isDangerousBuffer(buf) {
  const mime = await getMimeTypeFromBuffer(buf);
  logger.info(`POST upload: detected MIME type ${mime}`);
  if (BLOCKED_MIME_TYPES.has(mime) && !ALLOW_BINARIES_UPLOAD) return mime;
  if (COMPRESSED_MIME_TYPES.has(mime) && !ALLOW_COMPRESSED_UPLOAD) return mime;
  return null;
}

function is_allow_var( env_var, value ) {
  if ( env_var ) {
    const _env_var = env_var.toLowerCase(); 
    if ( _env_var === '0' || _env_var === 'false' || _env_var === 'disable' || _env_var === 'disabled' )
	  return false;
  }
  return true;
}

function normalize_tildpath(currentPath) {
  let normalizedPath=currentPath;
  logger.debug('normalize_directory currentPath=' + currentPath);
  try {
    if (currentPath.charAt(0) == '~')
          currentPath = path.join( rootdir, currentPath.substring(1) );
    normalizedPath = path.normalize(currentPath);
    const pathObj = path.parse(normalizedPath);
    const safePrefixCheck = rootdir.endsWith('/') ? rootdir : rootdir + '/';
    if (!pathObj.dir.startsWith(safePrefixCheck) && pathObj.dir !== rootdir && normalizedPath !== rootdir) {
	    normalizedPath = path.join( rootdir, normalizedPath);
	    normalizedPath = path.normalize(normalizedPath);
    }
  } catch (e) {
        logger.error('normalize_tildpath error', e);
  }
  return normalizedPath;
}
 


function checkSafePath(currentPath) {
  let bReturn = false;
  logger.debug('checkSafePath currentPath=' + currentPath);
  try {
    if (currentPath.charAt(0) == '~')
	  currentPath = path.join( rootdir, currentPath.substring(1) );
    const normalizedPath = path.normalize(currentPath);
    logger.debug('checkSafePath normalizedPath=' + normalizedPath);
    const pathObj = path.parse(normalizedPath);
    const safePrefixCheck = rootdir.endsWith('/') ? rootdir : rootdir + '/';
    if (pathObj.dir.startsWith(safePrefixCheck) || pathObj.dir === rootdir || normalizedPath === rootdir) {
      bReturn = true;
    }
  } catch (e) {
    	logger.error('checkSafePath error', e);
  }
  logger.debug(`checkSafePath return ${bReturn}`);
  return bReturn;
}

async function getNameTimeFile(file, dir) {
  try {
    const filepath = path.join(dir, file);
    const s = await fs.promises.stat(filepath);
    return { name: file, time: s.mtime.getTime() };
  } catch (err) {
    return { name: file, time: 0 };
  }
} 

async function getFilesSort(dir) {
  const files = await fs.promises.readdir(dir);
  const times = await Promise.all(
    files.map((file) => getNameTimeFile(file, dir)),
  );
  return times.sort((a, b) => a.time - b.time).map((v) => v.name);
}

async function dirExists(d) {
  try {
    const ls = await fs.promises.lstat(d);
    return ls.isDirectory();
  } catch (e) {
    logger.error('dirExists error', e);
    return false;
  }
}

/**
 *
 * @param {string} file
 * @param {*} zip
 * @desc Generate a zip for a given file
 */
async function generateZipTree(file, zip) {
  try {
    const realFile = await fs.promises.realpath(file);
    const safePrefixCheck = rootdir.endsWith('/') ? rootdir : rootdir + '/';
    if (!realFile.startsWith(safePrefixCheck) && realFile !== rootdir) {
      logger.warn('generateZipTree: symlink escape attempt blocked');
      return;
    }

    const ls = await fs.promises.lstat(realFile);
    const parts = realFile.split('/');
    const filename = parts[parts.length - 1];

    if (ls.isDirectory()) {
      const folder = zip.folder(filename);
      const filesDirectory = await fs.promises.readdir(realFile);
      await Promise.all(
        filesDirectory.map((f) => generateZipTree(`${realFile}/${f}`, folder)),
      );
    } else {
      const buffer = await fs.promises.readFile(realFile, { encoding: 'binary' });
      zip.file(filename, buffer, { encoding: 'binary' });
    }
  } catch (e) {
    logger.error('generateZipTree error', e);
  }
}

const app = express();
const router = express.Router();

app.use(helmet());

app.use(express.json());
app.use((req, _, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

/**
 * @swagger
 *
 * /:
 *   get:
 *     description: Get file from the home directory
 *     responses:
 *       '500':
 *         schema:
 *           type: object
 *           properties:
 *             code:
 *               type: integer
 *             data:
 *               string
 *       '403':
 *         schema:
 *           type: object
 *           properties:
 *             code:
 *               type: integer
 *             data:
 *               type: string
 *
 *       '404':
 *         schema:
 *           type: object
 *           properties:
 *             code:
 *               type: integer
 *             data:
 *               type: string
 */
router.get('/',
  middleWareFileQuery,
  asyncHandler(async (req, res) => {
    let { file } = req.query;
    logger.debug('GET file requested');


    if (!ALLOW_TO_SENDFILE) {
      logger.warn('GET file: request denied by configuration');
      res.status(400).send( DENIED_REQUEST_FILE_RESPONSE );
      return;
    }

    if (!checkSafePath(file)) {
      logger.warn('GET file: path is not safe (blocked)');
      res.status(400).send({ code: 400, data: 'Path Server Error' });
      return;
    }


    file = normalize_tildpath(file);

    let ls;
    try {
      ls = await fs.promises.lstat(file);
    } catch (e) {
      if (e.code === 'ENOENT') {
        res.status(404).send({ code: 404, data: 'Not found' });
        return;
      }
      throw e; 
    }

    if (!ls.isDirectory()) {
      pipeline(
        fs.createReadStream(file),
        res,
        (err) => {
          if (err) {
            logger.error('GET file: stream error', err);
          }
          res.end();
        },
      );
      return;
    }

    const zip = new JSZip();
    await generateZipTree(file, zip);

    const safeName = path.basename(file).replace(/[^\w\-. ]/g, '_');
    res.header(
      'Content-Disposition',
      `attachment; filename="${safeName}.zip"`,
    );
    res.setHeader('Content-Type', 'application/zip');

    pipeline(
      zip.generateNodeStream({
        type: 'nodebuffer',
        streamFiles: true,
        compressionOptions: {
          level: 9,
        },
      }),
      res,
      (err) => {
        if (err) {
          logger.error('GET directory zip: stream error', err);
        }
        res.end();
      },
    );
  }));

/**
 * @swagger
 *
 * /directory/list:
 *  get:
 *    description: List files in a given directory
 *    parameters:
 *    - in: query
 *      name: directoryName
 *      type: string
 *      required: true
 */
router.get('/directory/list',
  middleWareDirectoryQuery,
  asyncHandler(async (req, res) => {
    let { directory } = req.query;

    if (!ALLOW_TO_LISTFILE) {
      logger.warn('LIST directory: request denied by configuration');
      res.status(400).send( DENIED_REQUEST_FILE_RESPONSE );
      return;
    }

    // Check if the path is correct
    if (!checkSafePath(directory)) {
      logger.warn('LIST directory: path is not safe (blocked)');
      res.status(400).send({ code: 400, data: 'Path Server Error' });
      return;
    }

    directory = normalize_tildpath(directory);
    logger.debug('LIST directory: normalized path resolved');
    if (!(await exists(directory))) {
      logger.info('LIST directory: directory not found');
      res.status(404).send({ code: 404, data: 'Not found' });
    } else {
      const ls = await fs.promises.lstat(directory);
      if (ls.isDirectory()) {
        logger.debug('LIST directory: listing');
        res.status(200).send(await getFilesSort(directory));
      } else {
        logger.info('LIST directory: path is not a directory');
        res.status(404).send({ code: 404, data: `not a directory` });
      }
    }
  }));

/**
 * @swagger
 *
 * /:
 *  post:
 *    description: Upload a file at a given path
 *    requestBody:
 *      content:
 *        shema:
 *          type: object
 *          properties:
 *            fullPath:
 *              type: string
 *
 *    responses:
 *      '500':
 *        schema:
 *          type: object
 *          properties:
 *            code:
 *              type: integer
 *            data:
 *              type: string
 *
 *      '200':
 *        schema:
 *          type: object
 *          properties:
 *            code:
 *              type: integer
 *            data:
 *              type: string
 *
 *      '403':
 *        schema:
 *          type: object
 *          properties:
 *            code:
 *              type: integer
 *            data:
 *              type: string
 */
router.post('/', [upload.single('file'), middlewareCheckFile],
  asyncHandler(async (req, res) => {
    const { file } = req;
    const { fullPath = '' } = req.body;
    const { originalname, buffer } = file;
    const ret = { code: 403, data: 'Forbidden bad path' };
    logger.debug('POST upload: file received');

    // Check actual file type
    const dangerousType = await isDangerousBuffer(buffer);
    if (dangerousType) {
      logger.warn(`POST upload: blocked dangerous file content (${dangerousType})`);
      res.status(403).send({ code: 403, data: 'Forbidden: dangerous file content' });
      return;
    }

    const safeOriginalName = path.basename(originalname);
    let saveTo = (fullPath === '') ? safeOriginalName : fullPath;

    if (!ALLOW_TO_ACCEPTFILE) {
      logger.warn('POST upload: request denied by configuration');
      res.status(400).send( DENIED_REQUEST_FILE_RESPONSE );
      return;
    }

    saveTo = normalize_tildpath(saveTo);
    logger.debug('POST upload: path normalized');

    if (checkSafePath(saveTo)) {
      const pathObj = path.parse(saveTo);

      if (!(await dirExists(pathObj.dir))) {
        logger.info('POST upload: creating missing directory');
        try {
                fsextra.ensureDirSync(pathObj.dir);
        }
        catch (e) {
                logger.error('POST upload: failed to create directory', e);
          }
      }
      logger.debug('POST upload: writing file');
      await fs.promises.writeFile(saveTo, buffer);
      logger.info('POST upload: write done');
      ret.code = 200;
      ret.data = 'ok';
    }
    else {
      logger.warn('POST upload: path is not safe (blocked)');
    }

    res.status(ret.code).send(ret);
  }));

/**
 * @swagger
 * /:
 *   delete:
 *     description: Remove a given file wich is present in home directory
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *             - myFilename
 *             properties:
 *               myFilename:
 *                 type: string
 *     responses:
 *       '200':
 *        schema:
 *          type: object
 *          properties:
 *            code:
 *              type: integer
 *            data:
 *              type: string
 *
 *       '500':
 *         schema:
 *           type: object
 *           properties:
 *             code:
 *               type: integer
 *             data:
 *               type: strin
 *
 *       '404':
 *         schema:
 *           type: object
 *           properties:
 *             code:
 *               type: integer
 *             data:
 *               type: string
 *
 *       '403':
 *         schema:
 *           type: object
 *           properties:
 *             code:
 *               type: integer
 *             data:
 *               type: string
 *
 *       '400':
 *         schema:
 *           type: object
 *           properties:
 *             code:
 *               type: integer
 *             data:
 *               type: string
 */
router.delete('/',
  middleWareFileBody,
  asyncHandler(async (req, res) => {
    let { file } = req.body;
    const ret = { code: 400, data: 'Path server error' };
    logger.debug('DELETE file: request received');

    if (!ALLOW_TO_DELETEFILE) {
      logger.warn('DELETE file: request denied by configuration');
      res.status(400).send( DENIED_REQUEST_FILE_RESPONSE );
      return;
    }

    if (!checkSafePath(file)) {
      logger.warn('DELETE file: path is not safe (blocked)');
      res.status(400).send({ code: 400, data: 'Path Server Error' });
      return;
    }
    
    file = normalize_tildpath(file);
    try {
      await fs.promises.unlink(file);
      ret.code = 200;
      ret.data = 'ok';
    } catch (e) {
      if (e.code === 'ENOENT') {
        ret.code = 404;
        ret.data = 'Not Found';
      } else {
        throw e;
      }
    }
    

    res.status(ret.code).send(ret);
  }));

router.all('*', (req, res) => {
  const ret = {
    code: 404,
    data: `Can not ${req.method} ${req.path}`,
  };

  logger.warn(`Route not found: ${req.method} ${req.path}`);
  res.send(ret);
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _) => {
  logger.error(`Unhandled error on ${req.method} ${req.path}`);
  logger.error(err.stack);
  res.status(500).send({ code: 500, data: 'Internal server error' });
});

app.use(/\/(printer)?filer/, router);

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', err.stack);
});

listenDaemonOnContainerIpAddr(app, PORT, 'File-Service listening for requests');
