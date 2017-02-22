module.exports = {
    "extends": "airbnb-base",
    "plugins": [
        "import"
    ],
    rules: {
      "max-len": ["error", 180],
      "no-console": "off",
      "no-param-reassign": ["error", { "props": false }]
    }
};
