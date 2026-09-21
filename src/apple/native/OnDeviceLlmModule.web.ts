import { registerWebModule, NativeModule } from 'expo';

// OnDeviceLlmModule is not available on the web platform.
class OnDeviceLlmModule extends NativeModule<{}> {}

export default registerWebModule(OnDeviceLlmModule, 'OnDeviceLlmModule');
