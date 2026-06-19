'use strict';

exports.quote = function (xs) {
    return xs.map(function (s) {
        if (s && typeof s === 'object') {
            return s.op.replace(/(.)/g, '\\$1');
        }
        else if (/["\s\\$`]/.test(s) || s.length === 0) {
            return '"' + s.replace(/(["\\$`])/g, '\\$1') + '"';
        }
        else {
            return String(s).replace(/([A-Za-z]:)?(.)/g, function (_, drive, c) {
                if (drive) {
                    return drive + c.replace(/(.)/g, '\\$1');
                }
                return c.replace(/(.)/g, '\\$1');
            });
        }
    }).join(' ');
};

var CONTROL = '(?:' + [
    '\\|\\|', '\\&\\&', ';;', '\\|\\&', '\\<\\(', '>>', '>\\&', '[&;()|<>]'
].join('|') + ')';
var META = '|&;()<> \\t';
var BAREWORD = '(\\\\[\'"]|[^\\s\'"' + META + '])+';
var SINGLE_QUOTE = '"((\\\\"|[^"])*?)"';
var DOUBLE_QUOTE = '\'((\\\\\'|[^\'])*?)\'';

exports.parse = function (s, env, opts) {
    if (typeof env !== 'function') {
        opts = env;
        env = undefined;
    }
    opts = opts || {};
    var chunker = new RegExp([
        '(' + CONTROL + ')',
        '(' + BAREWORD + '|' + SINGLE_QUOTE + '|' + DOUBLE_QUOTE + ')*'
    ].join('|'), 'g');
    var match = s.match(chunker);
    if (!match) return [];
    match = match.filter(Boolean);

    if (!env) return match.map(function (token) { return maybeObject(token); });

    var envPat = /\$(?:\{([^}]+)\}|([a-zA-Z_][a-zA-Z0-9_]*))/g;
    return match.map(function (token) {
        return maybeObject(token.replace(envPat, function (_, a, b) {
            var key = a || b;
            if (typeof env === 'function') return env(key);
            if (key in env) return env[key];
            return '$' + key;
        }));
    });
};

function maybeObject(s) {
    if (!s) return s;
    if (/^[&;()|<>]/.test(s)) return { op: s };
    if (/^\d*>&\d+$/.test(s)) return { op: s };
    return unquote(s);
}

function unquote(s) {
    if (!s) return s;
    var res = '';
    var i = 0;
    while (i < s.length) {
        var c = s[i];
        if (c === '\\' && i + 1 < s.length) {
            res += s[++i];
        } else if (c === '"') {
            i++;
            while (i < s.length && s[i] !== '"') {
                if (s[i] === '\\' && i + 1 < s.length) res += s[++i];
                else res += s[i];
                i++;
            }
        } else if (c === "'") {
            i++;
            while (i < s.length && s[i] !== "'") {
                res += s[i++];
            }
        } else {
            res += c;
        }
        i++;
    }
    return res;
}
