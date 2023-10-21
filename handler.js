'use strict';

const aws = require('aws-sdk');
const S3 = new aws.S3();

const htmlparser2 = require("htmlparser2");
const solveChallenge = require("./solver/main");
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

const URLs = {
  'full': 'https://ecm.coopculture.it/index.php?option=com_snapp&task=event.getEventsCalendar&format=raw&id=D7E12B2E-46C4-074B-5FC5-016ED579426D&month=11&year=2023&lang=en',
  'simple': 'https://ecm.coopculture.it/index.php?option=com_snapp&task=event.getEventsCalendar&format=raw&id=3793660E-5E3F-9172-2F89-016CB3FAD609&month=11&year=2023&lang=en',
}

const SIGNAL_START = 1;
const SIGNAL_FAIL = 2;
const SIGNAL_SUCCESS = 3;


const BUCKET = process.env.BUCKET;

const catchChallengeScript = async () => {
    let URL = Object.values(URLs)[0];

    let response = await fetch(URL, {
        method: "GET",
        credentials: "omit",
        cache: "no-cache",
        headers: headers,
    })

    let htmlContent = await response.text()
    let isScriptStarted = false;

    let scriptContent = '';

    const parser = new htmlparser2.Parser({
        onopentag: function(name){
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

    return scriptContent;
}


const catchDates = async (URL) => {
    let response = await fetch(URL, {
        method: "GET",
        credentials: "omit",
        cache: "no-cache",
        headers: headers,
    })

    const datesAvailableStatus = {};

    const parser = new htmlparser2.Parser({
        onopentag: function(name, attribs){
            if (name === 'div') {
                const classList = (attribs.class || "").split(' ');
                if (classList.includes("day-number")) {
                    const date = attribs['data-date'];
                    datesAvailableStatus[date] = classList.includes("available");
                }
            }
        },
    });

    parser.parseComplete(await response.text());

    if (Object.keys(datesAvailableStatus).length < 14) {
        throw new Error('No dates available');
    }

    return datesAvailableStatus;
}

const filterAvailableDates = (dates) => {
    const availableDates = [];
    for (const date in dates) {
        if (dates[date]) {
            availableDates.push(date);
        }
    }
    return availableDates;
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
            return null;
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

module.exports.check = async (event) => {
    sendHealthCheck(SIGNAL_START).then();

    try {
        const previousAvailableDates = await readStateFromS3() || {};

        let scriptContent = await catchChallengeScript();
        const cookies = solveChallenge(scriptContent)
        console.log(cookies);

        headers.Cookie = '';
        for (const cookieName in cookies) {
            headers.Cookie += `${cookieName}=${cookies[cookieName]};`
        }

        let hasChanges = false;
        const newAvailableDates = {};
        for (const ticketType in URLs) {
            let datesAvailableStatus = await catchDates(URLs[ticketType]);

            newAvailableDates[ticketType] = filterAvailableDates(datesAvailableStatus);

            if (isArrayEqual(previousAvailableDates[ticketType], newAvailableDates[ticketType])) {
                console.log('No changes');
                await sendHealthCheck(SIGNAL_SUCCESS, 'No changes');

            } else {
                hasChanges = true;
                console.log('Changes detected');

                await sendToTelegram(`${ticketType} ticket - available dates: ${newAvailableDates[ticketType].join(', ')}`);
            }
        }

        if (!hasChanges) {
            await sendHealthCheck(SIGNAL_SUCCESS, 'No changes');
        } else {
            await sendHealthCheck(SIGNAL_SUCCESS, newAvailableDates);
        }

        await saveStateToS3(newAvailableDates);

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
