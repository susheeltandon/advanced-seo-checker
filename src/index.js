const http = require('http');
const parseURL = require('url-parse');
const request = require('request');
const urlExists = require('url-exists');
const normalizeUrl = require('normalize-url');
const mitt = require('mitt');
const createCrawler = require('./createCrawler');
const createAnalyzer = require('./createAnalyzer');
const isValidURL = require('./helpers/isValidURL');
const ssllabs = require("node-ssllabs");

module.exports = function AdvancedSEOChecker(uri, opts) {
  const defaultOpts = {
    maxDepth: 1,
    userAgent: 'Node/AdvancedSEOChecker',
    respectRobotsTxt: true,
    timeout: 30000,
    maxConcurrency: 5,
    downloadUnsupported: false
  };
  const crawlResults = []; // Store results in this array and then return it to caller

  if (!uri) {
    throw new Error('Requires a valid URL.');
  }

  const options = Object.assign({}, defaultOpts, opts);
  const emitter = mitt();
  const parsedUrl = parseURL(
    normalizeUrl(uri, {
      stripWWW: false,
      removeTrailingSlash: false
    })
  );

  const crawler = createCrawler(parsedUrl, options);

  const start = () => {
    crawler.start();
  };

  const stop = () => {
    crawler.stop();
  };

  const getValidatedURL = (url) => {
    // Check if user input protocol
    if (url.indexOf('http://') < 0 && url.indexOf('https://') < 0) { // TODO: Turn this into its own function
      url = 'http://' + url;
    }
    return url;
  }
  const load = (url) => {
    let limit = 3;
    const getPage = (url, done) => {
      request.get(url.toLowerCase(), function (error, response, body) {
        if (!error || limit === 0) {
          return done(error, body);
        }
        limit --;
        return getPage(url, done);
      });
    };
    const init = (resolve, reject) => {
      url = getValidatedURL(url);
      // Make request and fire callback
      getPage(url.toLowerCase(), function (error, body) {
        if (!error) {
          return resolve(body);
        }
        return resolve('');
      });
    };

    let promise = new Promise(init);
    return promise;
  };
  const analyze = (urls, bodies) => {
    let res = {};
    const analyzer = createAnalyzer();
    urls = Array.isArray(urls) ? urls : [urls];

    const onBodiesLoad = (bodies, resolve) => {
      console.log('Retrieving urls bodies done');
      console.log('Start analyzing urls');
      const promises = [validateSitemap(), validateRobots(), testSSLCertificate(normalizeUrl(uri)),
        analyzer.analyzePages(urls, bodies)];
      Promise.all(promises).then(function (result) {
        res = result[3];
        res.issues.notices.sitemap = result[0];
        res.issues.notices.robots = result[1];
        res.issues.warnings.ssl = result[2];
        console.log('Analyzing urls done');
        resolve(res);
      });
    };

    const init = (resolve, reject) => {
      if (bodies) {
        onBodiesLoad(bodies, resolve);
      }
      else {
        const bodiesPromises = [];
        for (let i = 0; i < urls.length; i++) {
          bodiesPromises.push(load(urls[i]));
        }
        console.log('Start retrieving urls bodies');
        Promise.all(bodiesPromises).then(function (bodies) {
          onBodiesLoad(bodies, resolve);
        });
      }
    };

    let promise = new Promise(init);
    return promise;
  };
  const testSSLCertificate = (url) => {
    const init = (resolve, reject) => {
      console.log('Starting SSLLabs test');
      ssllabs.scan(url, function (err, host) {
        console.log('Ending SSLLabs test');
        const result = {
          summary: '',
          grades: [],
          value: host
        };
        if (err) {
          return resolve(result);
        }
        host.endpoints.forEach(function (endpoint) {
          if (!endpoint.grade) {
            return;
          }
          result.grades.push(endpoint.grade);
        });
        result.summary = !result.grades.length ? 'No SSL certificate detected' : '';
        resolve(result);
      });
    };

    let promise = new Promise(init);
    return promise;
  };
  const validateSitemap = () => {
    let url = parsedUrl.href;
    const init = (resolve, reject) => {
      urlExists(normalizeUrl(url) + '/sitemap.xml', function (err, exists) {
        resolve({
          summary: !exists ? 'Sitemap.xml not found' : 'Sitemap.xml was found',
          value: exists
        });
      });
    };
    let promise = new Promise(init);
    return promise;
  };
  const validateRobots = () => {
    let url = parsedUrl.href;
    const init = (resolve, reject) => {
      urlExists(normalizeUrl(url) + '/robots.txt', function (err, exists) {
        resolve({
          summary: !exists ? 'Robots.txt not found' : 'Robots.txt was found',
          value: exists
        });
      });
    };
    let promise = new Promise(init);
    return promise;
  };

  const emitError = (code, url) => {
    emitter.emit('error', {
      code,
      message: http.STATUS_CODES[code],
      url
    });
  };

  const addURL = (url, body) => {
    const init = (resolve, reject) => {
      let urlObj = {url: url, body: body};
      crawlResults.push(urlObj);
      resolve(crawlResults[crawlResults.length - 1]);
    };

    let promise = new Promise(init);
    return promise;
  };
  const onComplete = () => {
    const urls = [], bodies = [];
    crawlResults.forEach(function (page, index, results) {
      urls.push(page.url);
      bodies.push(page.body);
    });
    analyze(urls, bodies).then(function (summary) {
      emitter.emit('done', summary);
    });
  };
  crawler.on('fetch404', ({url}) => emitError(404, url));
  crawler.on('fetchtimeout', ({url}) => emitError(408, url));
  crawler.on('fetch410', ({url}) => emitError(410, url));
  crawler.on('fetcherror', (queueItem, response) =>
    emitError(response.statusCode, queueItem.url)
  );

  crawler.on('fetchclienterror', (queueError, errorData) => {
    if (errorData.code === 'ENOTFOUND') {
      throw new Error(`Site "${parsedUrl.href}" could not be found.`);
    } else {
      emitError(400, errorData.message);
    }
  });

  crawler.on('fetchdisallowed', ({url}) => emitter.emit('ignore', url));

  crawler.on('fetchcomplete', (queueItem, responseBuffer, response) => {
    let url = queueItem.url;
    if (/<meta(?=[^>]+noindex).*?>/.test(responseBuffer)) {
      emitter.emit('ignore', url);
    } else if (isValidURL(url)) {
      emitter.emit('add', url);
      addURL(url, responseBuffer.toString());
    } else {
      emitError('404', url);
    }
  });
  crawler.on('complete', (queueItem, responseBuffer, response) => {
    onComplete();
  });
  return {
    on: emitter.on,
    off: emitter.off,
    start,
    stop,
    load,
    analyze
  }
};
