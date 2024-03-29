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
const fsextra = require('fs-extra')
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

const upload = multer({ storage: multer.memoryStorage() });
const exists = util.promisify(fs.exists);




const rootdir = process.env.HOME;
const PORT = process.env.FILE_SERVICE_TCP_PORT || 29783;
const ALLOW_TO_SENDFILE = is_allow_var( process.env.SENDFILE) ;
const ALLOW_TO_ACCEPTFILE = is_allow_var( process.env.ACCEPTFILE );
const ALLOW_TO_LISTFILE = is_allow_var( process.env.ACCEPTLISTFILE );
const ALLOW_TO_DELETEFILE = is_allow_var( process.env.ACCEPTDELETEFILE );

const DENIED_REQUEST_FILE_RESPONSE = { code: 403, data: 'Forbidden' };


console.log(`Service is listening on port ${PORT}`);
console.log(`Root dir is ${rootdir}`);
console.log(`ALLOW_TO_SENDFILE=${ALLOW_TO_SENDFILE}`);
console.log(`ALLOW_TO_ACCEPTFILE=${ALLOW_TO_ACCEPTFILE}`);
console.log(`ALLOW_TO_LISTFILE=${ALLOW_TO_LISTFILE}`);
console.log(`ALLOW_TO_DELETEFILE=${ALLOW_TO_DELETEFILE}`);



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
  console.log('normalize_directory currentPath=' + currentPath);
  try {
    if (currentPath.charAt(0) == '~')
          currentPath = rootdir + '/' + currentPath.substring(1);
    normalizedPath = path.normalize(currentPath);
    const pathObj = path.parse(normalizedPath);
    if (!pathObj.dir.startsWith(rootdir)) {
	    normalizedPath = rootdir + '/' + normalizedPath;
	    normalizedPath = path.normalize(normalizedPath);
    }
  } catch (e) {
        console.error(e);
  }
  return normalizedPath;
}
 


function checkSafePath(currentPath) {
  let bReturn = false;
  console.log('checkSafePath currentPath=' + currentPath);
  try {
    if (currentPath.charAt(0) == '~')
	  currentPath = rootdir + '/' + currentPath.substring(1);
    const normalizedPath = path.normalize(currentPath);
    console.log('checkSafePath normalizedPath=', normalizedPath);
    const pathObj = path.parse(normalizedPath);
    console.log('checkSafePath pathObj=', pathObj);
    if (pathObj.dir.startsWith(rootdir) || currentPath === rootdir) {
      bReturn = true;
    }
  } catch (e) {
    	console.error(e);
  }
  console.log(`checkSafePath return ${bReturn}`);
  return bReturn;
}

async function getNameTimeFile(file, dir) {
  const s = await fs.promises.stat(`${dir}/${file}`);
  return { name: file, time: s.mtime.getTime() };
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
    console.error(e);
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
    const ls = await fs.promises.lstat(file);
    const parts = file.split('/');
    const filename = parts[parts.length - 1];
    if (ls.isDirectory()) {
      const folder = zip.folder(filename);
      const filesDirectory = await fs.promises.readdir(file);

      await Promise.all(
        filesDirectory.map((f) => generateZipTree(`${file}/${f}`, folder)),
      );
    } else {
      const buffer = await fs.promises.readFile(file, { encoding: 'binary' });
      zip.file(filename, buffer, { encoding: 'binary' });
    }
  } catch (e) {
    console.error(e);
  }
}

const app = express();
const router = express.Router();

app.use(helmet());

app.use(express.json());
app.use((req, _, next) => {
  console.log('method:', req.method, 'on', req.path);
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
    console.log('file=', file);


    if (!ALLOW_TO_SENDFILE) {
      console.log( 'request is denied by configuration' );
      res.status(400).send( DENIED_REQUEST_FILE_RESPONSE );
      return;
    }

    if (!checkSafePath(file)) {
      console.log( `request to ${file} is denied path is not safe` );
      res.status(400).send({ code: 400, data: 'Path Server Error' });
      return;
    }


    file = normalize_tildpath(file);
    if (!(await exists(file))) {
      res.status(404).send({ code: 404, data: 'Not found' });
      return;
    }

    const ls = await fs.promises.lstat(file);
    if (!ls.isDirectory()) {
      pipeline(
        fs.createReadStream(file),
        res,
        (err) => {
          if (err) {
            console.error(err);
          }
          res.end();
        },
      );
      return;
    }

    const zip = new JSZip();
    await generateZipTree(file, zip);

    res.header(
      'Content-Disposition',
      `attachment; filename="${file}.zip"`,
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
          console.error(err);
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
      console.log( 'request is denied by configuration' );
      res.status(400).send( DENIED_REQUEST_FILE_RESPONSE );
      return;
    }

    // Check if the path is correct
    if (!checkSafePath(directory)) {
      console.log( `request to ${directory} is denied path is not safe` );
      console.log('Error on path:', directory);
      res.status(400).send({ code: 400, data: 'Path Server Error' });
      return;
    }

    directory = normalize_tildpath(directory);
    console.log('normalized directory:', directory);
    if (!(await exists(directory))) {
      console.log('Can not find directory:', directory);
      res.status(404).send({ code: 404, data: 'Not found' });
    } else {
      const ls = await fs.promises.lstat(directory);
      if (ls.isDirectory()) {
        console.log('listing directory:', directory);
        res.status(200).send(await getFilesSort(directory));
      } else {
        console.log(directory, 'is not a directory');
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
    // console.log( req );
    const { file } = req;
    const { fullPath = '' } = req.body;
    const { originalname, buffer } = file;
    const ret = { code: 403, data: 'Forbidden bad path' };
    console.log( 'file=', file );
    console.log( 'fullPath=', fullPath );
    console.log( 'originalname=', originalname );
    let saveTo = ( fullPath == '') ? originalname : fullPath;

    if (!ALLOW_TO_ACCEPTFILE) {
      console.log( 'request is denied by configuration' );
      res.status(400).send( DENIED_REQUEST_FILE_RESPONSE );
      return;
    }

    console.log( 'saveTo=', saveTo );
    saveTo = normalize_tildpath(saveTo);	
    console.log( 'normalized saveTo=', saveTo );

    if (checkSafePath(saveTo)) {
      const pathObj = path.parse(saveTo);

      if (!(await dirExists(pathObj.dir))) {
        console.log(`Create dir${pathObj.dir}`);
	try {
        	fsextra.ensureDirSync(pathObj.dir);
	}
	catch (e) {
    	   	console.error(e);
  	}
      }
      console.log(originalname, 'want to be save in', saveTo);
      console.log(`writing file ${saveTo}`);
      await fs.promises.writeFile(saveTo, buffer);
      console.log('Write done');
      ret.code = 200;
      ret.data = 'ok';
    }
    else {
      console.log( `request to ${saveTo} is denied path is not safe` );
      console.log( 'request is denied path is not safe' );
    }

    console.log(ret);
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
    console.log('file', file);
    console.log(`accessing file: ${file}`);

    if (!ALLOW_TO_DELETEFILE) {
      console.log( 'request is denied by configuration' ); 
      res.status(400).send( DENIED_REQUEST_FILE_RESPONSE );
      return;
    }

    if (!checkSafePath(file)) {
      console.log( `request to ${file} is denied path is not safe` );
      res.status(400).send({ code: 400, data: 'Path Server Error' });
      return;
    }
    else {
      file = normalize_tildpath(file);
      if (await exists(file)) {
        await fs.promises.unlink(file);
        ret.code = 200;
        ret.data = 'ok';
      } else {
        ret.code = 404;
        ret.data = 'Not Found';
      }
    }

    res.status(ret.code).send(ret);
  }));

router.all('*', (req, res) => {
  const ret = {
    code: 404,
    data: `Can not ${req.method} ${req.path}`,
  };

  console.error(ret);
  res.send(ret);
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _) => {
  console.error(req.path);
  console.error(err.stack);
  console.error(err.field);
  res.status(500).send({ code: 500, data: 'Internal server error' });
});

app.use(/\/(printer)?filer/, router);

process.on('uncaughtException', (err) => {
  console.error(err.stack);
});

listenDaemonOnContainerIpAddr(app, PORT, 'File-Service listening for requests');
