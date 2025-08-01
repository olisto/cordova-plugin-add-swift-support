/*
* This hook adds all the needed config to implement a Cordova plugin with Swift.
*
*  - It adds a Bridging header importing Cordova/CDV.h if it's not already
*    the case. Else it concats all the bridging headers in one single file.
*
*    /!\ Please be sure not naming your bridging header file 'Bridging-Header.h'
*    else it won't be supported.
*
*  - It puts the ios deployment target to 7.0 in case your project would have a
*    lesser one.
*
*  - It updates the ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES build setting to YES.
*
*  - It updates the SWIFT_VERSION to 4.0.
*/

const fs = require('fs');
const path = require('path');
const xcode = require('xcode');
const childProcess = require('child_process');
const semver = require('semver');
const glob = require('glob');

module.exports = context => {
  return new Promise(resolve => {
    const projectRoot = context.opts.projectRoot;

    // This script has to be executed depending on the command line arguments, not
    // on the hook execution cycle.
    if ((context.hook === 'after_platform_add' && context.cmdLine.includes('platform add')) ||
      (context.hook === 'after_prepare' && context.cmdLine.includes('prepare')) ||
      (context.hook === 'after_plugin_add' && context.cmdLine.includes('plugin add'))) {
      getPlatformVersionsFromFileSystem(context, projectRoot).then(platformVersions => {
        const IOS_MIN_DEPLOYMENT_TARGET = '9.0';
        const platformPath = path.join(projectRoot, 'platforms', 'ios');
        const config = getConfigParser(context, path.join(projectRoot, 'config.xml'));

        // Override faulty function
        config.getPreference = (attributeName, platform) => {
          let elems = config.doc.findall(`./platform[@name="${platform}"]/preference`)

          elems = Array.isArray(elems) ? elems : [elems];

          const value = elems.filter(elem =>
            elem.attrib.name.toLowerCase() === attributeName.toLowerCase()
          ).map(filteredElems =>
            filteredElems.attrib.value
          ).pop();

          return value || '';
        }

        let bridgingHeaderPath;
        let bridgingHeaderContent;
        let projectName;
        let projectPath;
        let pluginsPath;
        let iosPlatformVersion;
        let pbxprojPath;
        let xcodeProject;

        const COMMENT_KEY = /_comment$/;
        let buildConfigs;
        let buildConfig;
        let configName;

        platformVersions.forEach((platformVersion) => {
          if (platformVersion.platform === 'ios') {
            iosPlatformVersion = platformVersion.version;
          }
        });

        if (!iosPlatformVersion) {
          return;
        }

        projectName = 'App';
        projectPath = path.join(platformPath, projectName);
        pbxprojPath = path.join(platformPath, projectName + '.xcodeproj', 'project.pbxproj');
        xcodeProject = xcode.project(pbxprojPath);
        pluginsPath = path.join(projectPath, 'Plugins');

        xcodeProject.parseSync();

        bridgingHeaderPath = getBridgingHeaderPath(projectPath, iosPlatformVersion);

        try {
          fs.statSync(bridgingHeaderPath);
        } catch (err) {
          // If the bridging header doesn't exist, we create it with the minimum
          // Cordova/CDV.h import.
          bridgingHeaderContent = ['//',
            '//  Use this file to import your target\'s public headers that you would like to expose to Swift.',
            '//',
            '#import <Cordova/CDV.h>'];
          fs.writeFileSync(bridgingHeaderPath, bridgingHeaderContent.join('\n'), { encoding: 'utf-8', flag: 'w' });
          xcodeProject.addHeaderFile('Bridging-Header.h');
        }

        buildConfigs = xcodeProject.pbxXCBuildConfigurationSection();

        const bridgingHeaderProperty = '"$(PROJECT_DIR)/$(PROJECT_NAME)' + bridgingHeaderPath.split(projectPath)[1] + '"';

        let swiftOnlyTargets = config.getPreference('SwiftOnlyTargets', 'ios');
        let swiftOnlyProducts = [];
        if (swiftOnlyTargets) {
          swiftOnlyProducts = swiftOnlyTargets.split(',').map((i) => '"' + i + '"'); // product names are quoted
        }

        for (configName in buildConfigs) {
          if (!COMMENT_KEY.test(configName)) {
            buildConfig = buildConfigs[configName];
            if (getBuildProperty('SWIFT_OBJC_BRIDGING_HEADER', buildConfig) !== bridgingHeaderProperty) {
              let productName = getBuildProperty('PRODUCT_NAME', buildConfig);
              if (productName && swiftOnlyProducts.includes(productName)) {
                console.log('Will not set SWIFT_OBJC_BRIDGING_HEADER for', productName);
              } else {
                updateBuildProperty('SWIFT_OBJC_BRIDGING_HEADER', bridgingHeaderProperty, buildConfig);
                console.log('Update IOS build setting SWIFT_OBJC_BRIDGING_HEADER to:', bridgingHeaderProperty, 'for target', productName, 'for build configuration', buildConfig.name);
              }
            }
          }
        }

        // Look for any bridging header defined in the plugin
        glob('**/*Bridging-Header*.h', { cwd: pluginsPath }, (error, files) => {
          const bridgingHeader = path.basename(bridgingHeaderPath);
          const headers = files.map((filePath) => path.basename(filePath));

          // if other bridging headers are found, they are imported in the
          // one already configured in the project.
          let content = fs.readFileSync(bridgingHeaderPath, 'utf-8');

          if (error) throw new Error(error);

          headers.forEach((header) => {
            if (header !== bridgingHeader && !~content.indexOf(header)) {
              if (content.charAt(content.length - 1) !== '\n') {
                content += '\n';
              }
              content += '#import "' + header + '"\n';
              console.log('Importing', header, 'into', bridgingHeaderPath);
            }
          });
          fs.writeFileSync(bridgingHeaderPath, content, 'utf-8');

          for (configName in buildConfigs) {
            if (!COMMENT_KEY.test(configName)) {
              buildConfig = buildConfigs[configName];
              let productName = getBuildProperty('PRODUCT_NAME', buildConfig);
              if (parseFloat(getBuildProperty('IPHONEOS_DEPLOYMENT_TARGET', buildConfig)) < parseFloat(IOS_MIN_DEPLOYMENT_TARGET)) {
                updateBuildProperty('IPHONEOS_DEPLOYMENT_TARGET', IOS_MIN_DEPLOYMENT_TARGET, buildConfig);
                console.log('Update IOS project deployment target to:', IOS_MIN_DEPLOYMENT_TARGET, 'for target', productName, 'for build configuration', buildConfig.name);
              }

              if (getBuildProperty('ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES', buildConfig) !== 'YES') {
                updateBuildProperty('ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES', 'YES', buildConfig);
                console.log('Update IOS build setting ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES to: YES', 'for target', productName, 'for build configuration', buildConfig.name);
              }

              let searchPath = getBuildProperty('LD_RUNPATH_SEARCH_PATHS', buildConfig);
              if (typeof searchPath === 'undefined') {
                updateBuildProperty('LD_RUNPATH_SEARCH_PATHS', '"@executable_path/Frameworks"', buildConfig);
                console.log('Update IOS build setting LD_RUNPATH_SEARCH_PATHS to: @executable_path/Frameworks', 'for target', productName,'for build configuration', buildConfig.name);
              } else if (searchPath.indexOf('@executable_path/Frameworks') < 0) {
                searchPath += ' "@executable_path/Frameworks"';
                updateBuildProperty('LD_RUNPATH_SEARCH_PATHS', searchPath, buildConfig);
                console.log('Update IOS build setting LD_RUNPATH_SEARCH_PATHS to:', searchPath, 'for target', productName, 'for build configuration', buildConfig.name);
              }

              if (typeof getBuildProperty('SWIFT_VERSION', buildConfig) === 'undefined') {
                if (config.getPreference('UseLegacySwiftLanguageVersion', 'ios')) {
                  updateBuildProperty('SWIFT_VERSION', '2.3', buildConfig);
                  console.log('Use legacy Swift language version', buildConfig.name);
                } else if (config.getPreference('SwiftVersion', 'ios')) {
                  const swiftVersion = config.getPreference('SwiftVersion', 'ios');
                  updateBuildProperty('SWIFT_VERSION', swiftVersion, buildConfig);
                  console.log('Use Swift language version', swiftVersion);
                } else {
                  updateBuildProperty('SWIFT_VERSION', '4.0', buildConfig);
                  console.log('Update SWIFT version to 4.0', buildConfig.name);
                }
              }

              if (buildConfig.name === 'Debug') {
                if (getBuildProperty('SWIFT_OPTIMIZATION_LEVEL', buildConfig) !== '"-Onone"') {
                  updateBuildProperty('SWIFT_OPTIMIZATION_LEVEL', '"-Onone"', buildConfig);
                  console.log('Update IOS build setting SWIFT_OPTIMIZATION_LEVEL to: -Onone', 'for target', productName, 'for build configuration', buildConfig.name);
                }
              }
            }
          }

          fs.writeFileSync(pbxprojPath, xcodeProject.writeSync());
          resolve();
        });
      });
    } else {
      resolve();
    }
  });
};

const getBuildProperty = (propName, buildConfig) => {
  if (typeof buildConfig.buildSettings !== 'undefined') {
    return buildConfig.buildSettings[propName];
  }

  return null;
};

const updateBuildProperty = (propName, propValue, buildConfig) => {
  if (typeof buildConfig.buildSettings !== 'undefined') {
    buildConfig.buildSettings[propName] = propValue;
  }
};

const getConfigParser = (context, configPath) => {
  let ConfigParser;

  if (semver.lt(context.opts.cordova.version, '5.4.0')) {
    ConfigParser = context.requireCordovaModule('cordova-lib/src/ConfigParser/ConfigParser');
  } else {
    ConfigParser = context.requireCordovaModule('cordova-common/src/ConfigParser/ConfigParser');
  }

  return new ConfigParser(configPath);
};

const getBridgingHeaderPath = (projectPath, iosPlatformVersion) => {
  let bridgingHeaderPath;
  if (semver.lt(iosPlatformVersion, '4.0.0')) {
    bridgingHeaderPath = path.posix.join(projectPath, 'Plugins', 'Bridging-Header.h');
  } else {
    bridgingHeaderPath = path.posix.join(projectPath, 'Bridging-Header.h');
  }

  return bridgingHeaderPath;
};

const getPlatformVersionsFromFileSystem = (context, projectRoot) => {
  const cordovaUtil = context.requireCordovaModule('cordova-lib/src/cordova/util');
  const platformsOnFs = cordovaUtil.listPlatforms(projectRoot);
  const platformVersions = platformsOnFs.map(platform => {
    const script = path.join(projectRoot, 'platforms', platform, 'cordova', 'version');
    return new Promise((resolve, reject) => {
      childProcess.exec('"' + script + '"', {}, (error, stdout, _) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    }).then(result => {
      const version = result.replace(/\r?\n|\r/g, '');
      return { platform, version };
    }, (error) => {
      console.log(error);
      process.exit(1);
    });
  });

  return Promise.all(platformVersions);
};
