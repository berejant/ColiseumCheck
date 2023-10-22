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

const URLs = {
    'full': 'https://ecm.coopculture.it/index.php?option=com_snapp&task=event.getEventsCalendar&format=raw&id=D7E12B2E-46C4-074B-5FC5-016ED579426D&month=11&year=2023&lang=en',
    'simple': 'https://ecm.coopculture.it/index.php?option=com_snapp&task=event.getEventsCalendar&format=raw&id=3793660E-5E3F-9172-2F89-016CB3FAD609&month=11&year=2023&lang=en',
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

const fetchWithTimeout = async (URL) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 5000);

    let response = await fetch(URL, {
        signal: controller.signal,
        method: "GET",
        credentials: "omit",
        cache: "no-cache",
        headers: headers,
    })
    clearTimeout(id);

    return response;
}

const fetchWithSolveChallenge = async (URL) => {
    let response = await fetchWithTimeout(URL);

    if (response.headers.get('X-Octofence-Js-Function') === 'forwarded') {
        return response;
    }

    await resolveChallengeAndKeepCookieSingleton(response);
    return fetchWithTimeout(URL);
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

const isArrayEqual = (arr1, arr2) => {
    if (!Array.isArray(arr1) || !Array.isArray(arr2)) {
        return false;
    }

    if (arr1.length !== arr2.length) {
        return false;
    }

    for (const i in arr1) {
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
        console.log('No changes');
    } else {
        newAvailablePerType.hasChanges = true;
        console.log('Changes detected');

        await sendToTelegram(`${type} ticket - available dates: ${newAvailablePerType.join(', ')}`);
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

        let hasChanges = false;
        for (const ticketType in newAvailableDates) {
            newAvailableDates[ticketType] = await newAvailableDates[ticketType];
            hasChanges = hasChanges || newAvailableDates[ticketType].hasChanges || false;
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
