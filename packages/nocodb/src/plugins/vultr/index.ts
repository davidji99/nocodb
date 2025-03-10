import {XcActionType, XcType} from "nc-common";
import {XcPluginConfig} from "nc-plugin";

import VultrPlugin from "./VultrPlugin";

const config: XcPluginConfig = {
  builder: VultrPlugin,
  title: 'Vultr Object Storage',
  version: '0.0.1',
  logo: 'plugins/vultr.png',
  description: 'Using Vultr Object Storage can give flexibility and cloud storage that allows applications greater flexibility and access worldwide.',
  tags: 'Storage', inputs: {
    title: 'Configure Vultr Object Storage',
    items: [{
      key: 'bucket',
      label: 'Bucket Name',
      placeholder: 'Bucket Name',
      type: XcType.SingleLineText,
      required: true
    },
      //   {
      //   key: 'region',
      //   label: 'Region',
      //   placeholder: 'Region',
      //   type: XcType.SingleLineText,
      //   required: true
      // },
      {
        key: 'access_key',
        label: 'Access Key',
        placeholder: 'Access Key',
        type: XcType.SingleLineText,
        required: true
      }, {
        key: 'access_secret',
        label: 'Access Secret',
        placeholder: 'Access Secret',
        type: XcType.Password,
        required: true
      },],
    actions: [{
      label: 'Test',
      placeholder: 'Test',
      key: 'test',
      actionType: XcActionType.TEST,
      type: XcType.Button
    }, {
      label: 'Save',
      placeholder: 'Save',
      key: 'save',
      actionType: XcActionType.SUBMIT,
      type: XcType.Button
    },],
    msgOnInstall: 'Successfully installed and attachment will be stored in Vultr Object Storage',
    msgOnUninstall: '',
  },
  category: 'Storage',
}

export default config;