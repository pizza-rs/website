//kudos to: https://github.com/dgraph-io/dgraph-docs

function debounce(func, wait, immediate) {
    var timeout;

    return function () {
        var context = this,
            args = arguments;
        var later = function () {
            timeout = null;
            if (!immediate) func.apply(context, args);
        };

        var callNow = immediate && !timeout;
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        if (callNow) func.apply(context, args);
    };
}

function createCookie(name, val, days) {
    var expires = "";
    if (days) {
        var date = new Date();
        date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
        expires = "; expires=" + date.toUTCString();
    }

    document.cookie = name + "=" + val + expires + "; path=/";
}

function readCookie(name) {
    var nameEQ = name + "=";
    var ca = document.cookie.split(";");
    for (var i = 0; i < ca.length; i++) {
        var c = ca[i];
        while (c.charAt(0) == " ") c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
    }
    return null;
}

function eraseCookie(name) {
    createCookie(name, "", -1);
}

/**
 * getCurrentVersion gets the current doc version from the URL path and returns it
 *
 * @params pathname {String} - current path in a format of '/current/path'.
 * @return {String} - e.g. 'master', 'v7.7.1', ''
 *                    empty string denotes the latest version
 */
function getCurrentVersion(pathname) {
    let candidate;

    if (location.pathname.startsWith("/docs")) {
        candidate = pathname.split("/")[2];
    } else {
        candidate = pathname.split("/")[1];
    }

    if (candidate === "master") {
        return candidate;
    }

    if (/v\d+\.\d+/.test(candidate)) {
        return candidate;
    }

    if (/v\d+\.\d+\.\d+/.test(candidate)) {
        return candidate;
    }

    return "";
}

// getPathBeforeVersionName gets the current URL path before the version prefix
function getPathBeforeVersionName(location, versionName) {
    // if (location.pathname.startsWith("/docs")) {
    //     return "/docs/";
    // }
    return "/";
}

// getPathAfterVersionName gets the current URL path after the version prefix
function getPathAfterVersionName(location, versionName) {
    let path;
    // if (location.pathname.startsWith("/docs")) {
    //     if (versionName === "") {
    //         path = location.pathname
    //             .split("/")
    //             .slice(2)
    //             .join("/");
    //     } else {
    //         path = location.pathname
    //             .split("/")
    //             .slice(3)
    //             .join("/");
    //     }
    //     return path + location.hash;
    // }

    if (versionName === "") {
        path = location.pathname
            .split("/")
            .slice(1)
            .join("/");
    } else {
        path = location.pathname
            .split("/")
            .slice(2)
            .join("/");
    }

    return path + location.hash;
}

(function () {

    // version selector
    var currentVersion = getCurrentVersion(location.pathname);
    const versionSelectors = document.getElementsByClassName("version-selector");
    if (versionSelectors.length) {
        versionSelectors[0].addEventListener("change", function (e) {
            // targetVersion: '', 'master', 'v0.7.7', 'v0.7.6', etc.
            var targetVersion = e.target.value;

            if (currentVersion !== targetVersion) {
                var basePath = getPathBeforeVersionName(location, currentVersion);
                // Getting everything after targetVersion and concatenating it with the hash part.
                var currentPath = getPathAfterVersionName(location, currentVersion);

                var targetPath;
                if (targetVersion === "") {
                    targetPath = basePath + currentPath;
                } else {
                    targetPath = basePath + targetVersion + "/" + currentPath;
                }
                location.assign(targetPath);
            }
        });

        var versionSelector = versionSelectors[0],
            options = versionSelector.options;

        for (var i = 0; i < options.length; i++) {
            if (options[i].value.indexOf("latest") != -1) {
                options[i].value = options[i].value.replace(/\s\(latest\)/, "");
            }
        }

        for (var i = 0; i < options.length; i++) {
            if (options[i].value === currentVersion) {
                options[i].selected = true;
                break;
            }
        }
        (" ");
    }

    // Add target = _blank to all external links.
    var links = document.links;

    for (var i = 0, linksLength = links.length; i < linksLength; i++) {
        if (links[i].hostname != window.location.hostname) {
            links[i].target = "_blank";
        }
    }

})();
