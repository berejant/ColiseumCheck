const babelParser = require("@babel/parser");

const getOctofenceJslc = require("./helpers/cookieExtractor");
const generateFingerPrint = require("./helpers/fingerprint");

module.exports = function solveChallenge(script) {
    const ast = babelParser.parse(script, {
        sourceType: "module",
        plugins: ["jsx"]
    });
    return {
        "octofence_jslc":       getOctofenceJslc(ast),
        "octofence_jslc_fp":    generateFingerPrint().toString()
    }
}
