/** Independent Client constructors never receive ordinary Hook link callbacks. */
export const CLIENT_MARKDOWN_FACTORY = String.raw`
  elements.Markdown=raw=>{
    const input=raw===undefined||raw===null?{}:raw;
    if(typeof input!=="object"||Array.isArray(input))throw Error("MODS_UI_MARKDOWN_INVALID");
    const prototype=Object.getPrototypeOf(input);
    if(prototype!==null&&prototype!==Object.prototype)throw Error("MODS_UI_MARKDOWN_INVALID");
    const data={};
    for(const key of Reflect.ownKeys(input)){
      if(typeof key!=="string"||!["text","key","dimColor","children"].includes(key))
        throw Error("MODS_UI_MARKDOWN_INVALID");
      const field=Object.getOwnPropertyDescriptor(input,key);
      if(!field||!field.enumerable||!("value" in field))throw Error("MODS_UI_MARKDOWN_INVALID");
      if(key==="children"){
        if(children([field.value]).length)throw Error("MODS_UI_MARKDOWN_INVALID");
      }else data[key]=field.value;
    }
    const text=(value,max)=>typeof value==="string"&&value.length<=max&&
      !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value);
    if(!Object.hasOwn(data,"text")||!text(data.text,10000)||
      (Object.hasOwn(data,"key")&&(!text(data.key,256)||!data.key))||
      (Object.hasOwn(data,"dimColor")&&typeof data.dimColor!=="boolean"))
      throw Error("MODS_UI_MARKDOWN_INVALID");
    return freeze({type:"Markdown",props:freeze(data)});
  };
`
