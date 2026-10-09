/** Prevent navigation after page handlers receive clicks/submits, so delegated
 * tab and form interactions still run inside the design preview. */
export const DESIGN_PREVIEW_NAVIGATION_SCRIPT = `(function(){
  if(window.__nb_active)return;
  window.__nb_active=true;
  window.addEventListener('click',function(e){
    var el=e.target;
    while(el&&el!==document){
      if(el.localName==='a'&&el.hasAttribute('href')){
        var href=el.getAttribute('href');
        if(e.defaultPrevented)return;
        if(el.hasAttribute('download')&&/^(blob:|data:)/i.test(href||''))return;
        e.preventDefault();
        // A file base URL would otherwise make fragment links load the file.
        if(href&&href.charAt(0)==='#'){
          window.location.hash=href;
          var id=href.slice(1);
          try{id=decodeURIComponent(id);}catch(_){}
          var target=document.getElementById(id)||document.getElementsByName(id)[0];
          if(target)target.scrollIntoView();
        }
        return;
      }
      el=el.parentElement;
    }
  });
  window.addEventListener('submit',function(e){e.preventDefault();});
})();`
