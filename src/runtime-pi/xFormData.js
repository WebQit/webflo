
/**
 * @imports
 */
import { formData } from './util-http.js';

 /**
  * The _Headers Mixin
  */
export default class xFormData extends FormData {

    json(data = {}) {
        const result = formData.call(this, ...arguments);
        return result[0];
    }

    static compat(formData) {
        if (formData instanceof this) return formData;
        if (formData instanceof FormData) {
            return Object.setPrototypeOf(formData, new this);
        }
    }

}