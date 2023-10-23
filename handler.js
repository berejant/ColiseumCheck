'use strict';

const aws = require('aws-sdk');
const S3 = new aws.S3();
const fs = require('fs');

const htmlparser2 = require("htmlparser2");
const solveChallenge = require("./solver/main");

const SIGNAL_START = 1;
const SIGNAL_FAIL = 2;
const SIGNAL_SUCCESS = 3;

const BUCKET = process.env.BUCKET;

const targetDate = '22/11/2023';

const targetDateObject = new Date(targetDate.split('/').reverse().join('-'));

const URLs = {
    'full': 'https://ecm.coopculture.it/index.php?option=com_snapp&task=event.getEventsCalendar&format=raw&id=D7E12B2E-46C4-074B-5FC5-016ED579426D&month=11&year=2023&lang=en',
    'simple': 'https://ecm.coopculture.it/index.php?option=com_snapp&task=event.getEventsCalendar&format=raw&id=3793660E-5E3F-9172-2F89-016CB3FAD609&month=11&year=2023&lang=en',
}

const timeURLs= {
    'full': 'https://ecm.coopculture.it/index.php?option=com_snapp&task=event.getperformancelist&format=raw&id=D7E12B2E-46C4-074B-5FC5-016ED579426D&type=1&date_req=' + targetDate + '&dispoonly=0&lang=en',
    'simple': 'https://ecm.coopculture.it/index.php?option=com_snapp&task=event.getperformancelist&format=raw&id=3793660E-5E3F-9172-2F89-016CB3FAD609&type=1&date_req=' + targetDate + '&dispoonly=0&lang=en',
}

const headers = {
    "authority": "ecm.coopculture.it",
    "accept": "text/html, */*; q=0.01",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "referer": "https://ecm.coopculture.it/index.php?option=com_snapp&view=event&id=3793660E-5E3F-9172-2F89-016CB3FAD609&catalogid=B79E95CA-090E-FDA8-2364-017448FF0FA0&lang=it",
    "sec-ch-ua": '"Google Chrome";v="117", "Not;A=Brand";v="8", "Chromium";v="117"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"macOS\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36",
    "x-requested-with": "XMLHttpRequest"
}

const saveHtmlToS3 = async (name, data) => {
    const filename = `${(new Date).toISOString()}_${name}.html`;

    const params = {
        Bucket: BUCKET,
        Key: `html/` + filename,
        Body: data,
    };

    await S3.putObject(params).promise();

    return filename;
}

const fetchWithTimeoutAndRetry = async (URL) => {
    let controller;
    let id;
    for (let i = 2; i >= 0; i--) {
        try {
            controller = new AbortController();
            id = setTimeout(() => controller.abort(), 3000);

            let response = await fetch(URL, {
                signal: controller.signal,
                method: "GET",
                credentials: "omit",
                cache: "no-cache",
                headers: headers,
            })
            clearTimeout(id);

            return response;
        } catch (e) {
            console.log('Fetch error: ' + e.message);
            if (i === 0) {
                throw e;
            }
        }
    }
}

const fetchWithSolveChallenge = async (URL) => {
    let response = await fetchWithTimeoutAndRetry(URL);

    if (response.headers.get('X-Octofence-Js-Function') === 'forwarded') {
        return response;
    }

    await resolveChallengeAndKeepCookieSingleton(response);
    return fetchWithTimeoutAndRetry(URL);
}


const resolveChallengeAndKeepCookie = async (response) => {
    let scriptContent = await extractScriptFromResponse(response);
    let cookies;
    for (let i = 2; i >= 0; i--) {
        console.log("Solving challenge. Script length: " + scriptContent.length)
        cookies = solveChallenge(scriptContent)
        console.log(cookies)

        if (isCookiesValid(cookies)) {
            break;
        }
    }

    saveCookiesToFile(cookies);
    setCookieHeader(cookies);
}

let lastSolvingChallengePromise = null;
const resolveChallengeAndKeepCookieSingleton = (response) => {
    if (!lastSolvingChallengePromise) {
        lastSolvingChallengePromise = resolveChallengeAndKeepCookie(response)
        lastSolvingChallengePromise.finally(() => {
            setTimeout(() => {
                lastSolvingChallengePromise = null;
            }, 2000)
        });
    }

    return lastSolvingChallengePromise;
}

const setCookieHeader = (cookies) => {
    headers.Cookie = '';
    for (const cookieName in cookies) {
        headers.Cookie += `${cookieName}=${cookies[cookieName]};`
    }
}

const extractScriptFromResponse = async (response) => {
    let htmlContent = await response.text()
    let isScriptStarted = false;

    let scriptContent = '';

    const parser = new htmlparser2.Parser({
        onopentag: function(name) {
            if (name === 'script' && scriptContent === '') {
                isScriptStarted = true;
            }
        },

        ontext: function(text){
            if (isScriptStarted) {
                scriptContent += text;
            }
        },

        onclosetag(name) {
            if (name === 'script') {
                isScriptStarted = false;
            }
        }
    });

    parser.parseComplete(htmlContent);

    if (!scriptContent || scriptContent.length < 100) {
        const logFilename = await saveHtmlToS3('challenge-no-script', htmlContent);
        throw new Error('Script not found. Saved html to ' + logFilename);
    }

    return scriptContent;
}


const catchDates = async (URL) => {
    let response = await fetchWithSolveChallenge(URL);

    const availableDatesList = [];
    let capturedDateCount = 0;
    const parseDateDiv = (name, attribs) => {
        if (name !== 'div') {
            return null;
        }

        if (!attribs['data-date']) {
            return null;

        }
        const classList = (attribs.class || "").split(' ');

        if (!classList.includes("day-number")) {
            return null;
        }

        return {
            date: attribs['data-date'],
            available: classList.includes("available"),
        }
    }

    const parser = new htmlparser2.Parser({
        onopentag: function(name, attribs) {
            let dateDivData = parseDateDiv(name, attribs);
            if (dateDivData) {
                capturedDateCount++;
                if (dateDivData.available) {
                    availableDatesList.push(dateDivData.date)
                }
            }
        },
    });

    let htmlContent = await response.text()
    parser.parseComplete(htmlContent);
    if (capturedDateCount < 14) {
        const logFilename = await saveHtmlToS3('dates', htmlContent);
        throw new Error('No dates available. Saved html to ' + logFilename);
    }

    return availableDatesList;
}


const catchTimes = async (URL) => {
    let response = await fetchWithSolveChallenge(URL);

    /*
    <div class="perf_row even row-height2 text-center">
        <div class='col-md-4 col-sm-4 col-xs-4'>
                <div>08:40</div>
                <div class="upspacer10"> </div>
        </div>
            <div class='col-md-8 col-sm-8 col-xs-8 nopadding'>
            <button href="#" class="btn-modalproduct btn btn-success btn-block  showPerformance" data-performanceid="A7C12AEE-88CD-B502-5407-018B1E2FA2E6">
               Available  <span class="brfrmnc-remaining"> (83) </span>
            </button>
        </div>
    </div>
     */

    const availableTimesListWithRemaining = [];
    let capturedTimeCount = 0;

    let isTimeDivStarted = false;
    let isTimeButtonStarted = false;
    let isRemainingSpanStarted = false;
    let divLevelCount = 0;

    let currentTime = '';
    let currentAvailable = false;
    let remainingCount = 0;

    let actualDataDisplayDate = '';

    const isTimeRegex = /^\d\d:\d\d$/;

    const parser = new htmlparser2.Parser({
        onopentag: function(name, attribs) {
            if (attribs['data-displaydate'] && !actualDataDisplayDate) {
                actualDataDisplayDate = attribs['data-displaydate'];
            }

            const classList = (attribs.class || "").split(' ');
            isTimeDivStarted = isTimeDivStarted || classList.includes("perf_row");


            if (isTimeDivStarted && name === 'div') {
                divLevelCount++;
            }

            if (isTimeDivStarted && name === 'button') {
                isTimeButtonStarted = true;
            }

            if (isTimeButtonStarted && name === 'span') {
                isRemainingSpanStarted = true;
            }
        },

        ontext: function(text) {
            text = text.trim();


            if (isTimeDivStarted && text) {
                if (isRemainingSpanStarted) {
                    remainingCount = Number(text.replace(/\D/g, ''));
                } else if (isTimeButtonStarted) {
                    currentAvailable = currentAvailable || text === 'Available';

                } else if (isTimeRegex.test(text)) {
                    currentTime = text;
                }
            }
        },

        onclosetag(name) {
            if (isTimeDivStarted && name === 'div') {
                divLevelCount--;
            }

            if (isTimeButtonStarted && name === 'button') {
                isTimeButtonStarted = false;
            }

            if (isRemainingSpanStarted && name === 'span') {
                isRemainingSpanStarted = false;
            }

            if (isTimeDivStarted && divLevelCount === 0) {
                capturedTimeCount++;
                if (currentAvailable) {
                    availableTimesListWithRemaining.push({
                        time: currentTime,
                        remaining: remainingCount,
                    });
                }
                isTimeDivStarted = false;
                isTimeButtonStarted = false;
                isRemainingSpanStarted = false;
                currentAvailable = false;
                currentTime = '';
            }
        }
    });

    let htmlContent = await response.text()
    parser.parseComplete(htmlContent);

    const isValidPage = capturedTimeCount && (new Date(actualDataDisplayDate) - targetDateObject) === 0;

    if (!isValidPage) {
        const logFilename = await saveHtmlToS3('times', htmlContent);
        throw new Error('No times available . Saved html to ' + logFilename);
    }

    return availableTimesListWithRemaining
        .filter(time => time.remaining >= 2)
        .map(time => time.time);
}


const sendHealthCheck = async (signal, postData) => {
    let signalString = '';
    if (signal === SIGNAL_SUCCESS) {
        signalString = '';
    } else if (signal === SIGNAL_FAIL) {
        signalString = '/fail';
    } else if (signal === SIGNAL_START) {
        signalString = '/start';
    } else {
        console.log('Unknown signal');
        return;
    }

    if (!postData) {
        postData = '';
    }

    if (typeof postData !== 'string') {
        postData = JSON.stringify(postData, null, 2);
    }

    await fetch(process.env.HEALTHCHECK_URL + signalString, {
        method: "POST",
        credentials: "omit",
        cache: "no-cache",
        headers: {
            "Content-Type": "text/plain",
        },
        body: postData,
    })

}

const sendToTelegram = async (message) => {
    const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

    const sendMessagePayload = {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: message,
    }

    const response = await fetch(telegramUrl, {
        method: "POST",
        credentials: "omit",
        cache: "no-cache",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(sendMessagePayload),
    })

    const telegramResponse = await response.json();

    if (!telegramResponse['ok']) {
        throw new Error('Telegram response is not ok: ' + JSON.stringify(telegramResponse));
    }
}

const readStateFromS3 = async () => {
    try {
        const params = {
            Bucket: BUCKET,
            Key: `state.json`,
        };

        const data = await S3.getObject(params).promise();

        return JSON.parse(data.Body.toString());
    } catch (e) {
        if (e.code === 'NoSuchKey') {
            return {};
        }

        throw e;
    }
}

const saveStateToS3 = async (data) => {
    const params = {
        Bucket: BUCKET,
        Key: `state.json`,
        Body: JSON.stringify(data),
    };

    await S3.putObject(params).promise();
}

function deepEqual(x, y) {
    const ok = Object.keys, tx = typeof x, ty = typeof y;
    return x && y && tx === 'object' && tx === ty ? (
        ok(x).length === ok(y).length &&
        ok(x).every(key => deepEqual(x[key], y[key]))
    ) : (x === y);
}

const isArrayEqual = (arr1, arr2) => {
    if (!Array.isArray(arr1) || !Array.isArray(arr2)) {
        return false;
    }

    if (arr1.length !== arr2.length) {
        return false;
    }

    for (const i in arr1) {
        if (arr1[i] === arr2[i]) {
            continue;
        }

        if (typeof arr1[i] === 'object') {
            if (!deepEqual(arr1[i], arr2[i])) {
                return false;
            }
        }

        if (arr1[i] !== arr2[i]) {
            return false;
        }
    }

    return true;
}

const COOKIE_FILE_PATH = '/tmp/cookies.json';
const loadCookiesFromFile = async () => {
    if (!fs.existsSync(COOKIE_FILE_PATH)) {
        return null;
    }

    const { birthtime } = fs.statSync(COOKIE_FILE_PATH)
    const now = new Date()
    if ((now - birthtime) > 1E3 * 60 * 60) { // 1 hour
        return null;
    }
    console.log('Cookie file exists ' + birthtime)

    return JSON.parse(await fs.promises.readFile(COOKIE_FILE_PATH, 'utf8'));
}

const saveCookiesToFile = (cookies) => {
    fs.writeFileSync(COOKIE_FILE_PATH, JSON.stringify(cookies));
}

const isCookiesValid = (cookies) => !(!cookies || !cookies.octofence_jslc || !cookies.octofence_jslc_fp);

const checkTypeDateAvailable = async (type, previousAvailablePerType) => {
    if (!URLs[type]) {
        throw new Error('Unknown type');
    }

    const newAvailablePerType = await catchDates(URLs[type]);

    if (isArrayEqual(previousAvailablePerType, newAvailablePerType)) {
        console.log('No changes in dates');
    } else {
        newAvailablePerType.hasChanges = true;
        console.log('Changes detected in dates');

        await sendToTelegram(`${type} ticket - available dates: ${newAvailablePerType.join(', ')}`);
    }

    return newAvailablePerType;
}

const checkTypeTimeAvailable = async (type, previousAvailablePerType) => {
    if (!URLs[type]) {
        throw new Error('Unknown type');
    }

    const newAvailablePerType = await catchTimes(timeURLs[type]);

    if (isArrayEqual(previousAvailablePerType, newAvailablePerType)) {
        console.log('No changes inm time');
    } else {
        newAvailablePerType.hasChanges = true;
        console.log('Changes in time detected');

        await sendToTelegram(`${type} ticket - available times: ${newAvailablePerType.join(', ')}`);
    }

    return newAvailablePerType;
}

module.exports.check = async (event) => {
    try {
        lastSolvingChallengePromise = null;

        const [previousAvailableDates] = await Promise.all([
            readStateFromS3(),
            sendHealthCheck(SIGNAL_START),
            loadCookiesFromFile().then(cookies => cookies && setCookieHeader(cookies)),
        ]);

        const newAvailableDates = {};

        for (const ticketType in URLs) {
            newAvailableDates[ticketType] = checkTypeDateAvailable(ticketType, previousAvailableDates[ticketType])
        }

        for (const ticketType in timeURLs) {
            const key = ticketType + 'Time';
            newAvailableDates[key] = checkTypeTimeAvailable(ticketType, previousAvailableDates[key])
        }

        let hasChanges = false;
        for (const ticketType in newAvailableDates) {
            newAvailableDates[ticketType] = await newAvailableDates[ticketType];
            hasChanges = hasChanges || newAvailableDates[ticketType].hasChanges || false;

            delete newAvailableDates[ticketType].hasChanges;
        }

        console.log('Saving state, changes: ', hasChanges)
        await Promise.all([
            saveStateToS3(newAvailableDates),
            sendHealthCheck(SIGNAL_SUCCESS, {
                message: hasChanges ? 'Changes detected' : 'No changes',
                newAvailableDates: newAvailableDates,
            }),
        ])

        return {
            statusCode: 200,
            body: JSON.stringify(newAvailableDates,
                null,
                2
            ),
        };

    } catch (e) {
        console.log(e);
        await sendHealthCheck(SIGNAL_FAIL, e.message);

        return {
            statusCode: 500,
            body: JSON.stringify(
                {
                    message: e.message,
                },
                null,
                2
            ),
        };
    }

};
